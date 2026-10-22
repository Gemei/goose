use std::collections::HashMap;

use rmcp::model::ProtocolVersion;
use rmcp::transport::ConfigureCommandExt;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::super::container::Container;
use super::super::extension::{ExtensionError, ExtensionResult, ProcessExit};
use super::super::extension_malware_check;
use super::super::mcp_client::{ConnectContext, McpClient};
use crate::config::search_path::SearchPaths;
use crate::subprocess::spawn_long_lived_mcp_subprocess;

pub(super) async fn connect(
    cmd: &str,
    args: &[String],
    envs: HashMap<String, String>,
    container: Option<&Container>,
    mut ctx: ConnectContext,
) -> ExtensionResult<McpClient> {
    extension_malware_check::deny_if_malicious_cmd_args(cmd, args).await?;

    if let Some(container) = container {
        ctx.docker_container = Some(container.id().to_string());
        tracing::info!(
            container = %container.id(),
            cmd = %cmd,
            "Starting stdio extension inside Docker container"
        );
    }
    let make_command = || match container {
        Some(container) => docker_exec(container, envs.clone(), cmd, args),
        None => Command::new(resolve_command(cmd)).configure(|command| {
            command.args(args).envs(envs.clone());
        }),
    };
    // `server/discover` can close a legacy stdio server before the old
    // initialize handshake runs. HTTP retries that case; stdio needs a new
    // process because the first one has already exited.
    let retry_legacy = ctx.capabilities.protocol_version.is_none();
    let first = spawn(make_command(), ctx.clone()).await;
    let Err(error) = first else {
        return first;
    };
    if !retry_legacy || !handshake_failed(&error) {
        return Err(error);
    }
    tracing::warn!(
        %error,
        "stdio MCP discover handshake failed; retrying with legacy initialize"
    );
    let mut legacy = ctx;
    legacy.capabilities.protocol_version = Some(ProtocolVersion::V_2025_11_25);
    spawn(make_command(), legacy).await
}

fn handshake_failed(error: &ExtensionError) -> bool {
    matches!(
        error,
        ExtensionError::ProcessExit(_) | ExtensionError::InitializeError(_)
    )
}

pub(super) fn docker_exec(
    container: &Container,
    envs: HashMap<String, String>,
    program: &str,
    args: &[String],
) -> Command {
    Command::new("docker").configure(|command| {
        command.arg("exec").arg("-i");
        for (key, value) in envs {
            command.arg("-e").arg(format!("{}={}", key, value));
        }
        command.arg(container.id()).arg(program).args(args);
    })
}

fn resolve_command(cmd: &str) -> std::path::PathBuf {
    SearchPaths::builder()
        .with_npm()
        .resolve(cmd)
        .unwrap_or_else(|_| {
            // let the OS raise the error
            std::path::PathBuf::from(cmd)
        })
}

pub(super) async fn spawn(mut command: Command, ctx: ConnectContext) -> ExtensionResult<McpClient> {
    if let Ok(path) = SearchPaths::builder().path() {
        command.env("PATH", path);
    }

    if ctx.working_dir.is_dir() {
        tracing::info!(
            "Setting MCP process working directory: {:?}",
            ctx.working_dir
        );
        command.current_dir(&ctx.working_dir);
    } else {
        tracing::warn!(
            "Working directory doesn't exist or isn't a directory: {:?}",
            ctx.working_dir
        );
    }

    let (transport, mut stderr) = spawn_long_lived_mcp_subprocess(command).await?;
    let mut stderr = stderr.take().ok_or_else(|| {
        ExtensionError::SetupError("failed to attach child process stderr".to_owned())
    })?;

    let stderr_task = tokio::spawn(async move {
        let mut all_stderr = Vec::new();
        stderr.read_to_end(&mut all_stderr).await?;
        Ok::<String, std::io::Error>(String::from_utf8_lossy(&all_stderr).into())
    });

    match McpClient::connect(transport, ctx).await {
        Ok(client) => Ok(client),
        Err(error) => Err(match stderr_task.await? {
            Ok(stderr_content) => ProcessExit::new(stderr_content, error).into(),
            Err(e) => e.into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::service::ClientInitializeError;

    #[test]
    fn discover_handshake_failures_are_retried() {
        let closed = ExtensionError::from(ClientInitializeError::ConnectionClosed(
            "discover response".into(),
        ));
        assert!(handshake_failed(&closed));

        let exit = ExtensionError::from(ProcessExit::new(
            "client disconnected",
            Box::new(ClientInitializeError::Cancelled),
        ));
        assert!(handshake_failed(&exit));
        assert!(!handshake_failed(&ExtensionError::SetupError(
            "failed to attach child process stderr".into()
        )));
    }
}
