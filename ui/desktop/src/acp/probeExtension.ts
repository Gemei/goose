import { methods, type NewSessionResponse } from '@agentclientprotocol/sdk';
import { getAcpClient } from './acpConnection';
import { extensionConfigToGooseExtension } from './extensions';
import {
  createExtensionConfig,
  nameToKey,
  type ExtensionFormData,
} from '../components/settings/extensions/utils';

export interface ProbeTool {
  name: string;
  description: string;
}

export interface ToolDescriptionParts {
  summary: string;
  /** Documented error responses. Empty when the tool description has none. */
  errors: string;
}

const ERROR_RESPONSES = /error responses\s*:/i;

/** Split a tool description into its summary and any "Error Responses:" section. */
export function splitToolDescription(description: string): ToolDescriptionParts {
  const match = ERROR_RESPONSES.exec(description);
  if (!match) return { summary: description.trim(), errors: '' };
  return {
    summary: description.slice(0, match.index).trim(),
    errors: description.slice(match.index).trim(),
  };
}

const SECRET_PLACEHOLDER = '••••••••';

/** Stored secrets the probe must not overwrite with the masked placeholder. */
export function envKeysToStore(formData: ExtensionFormData): { key: string; value: string }[] {
  return formData.envVars.filter(
    (envVar) =>
      envVar.key.trim() !== '' && envVar.value.trim() !== '' && envVar.value !== SECRET_PLACEHOLDER
  );
}

/**
 * Start the MCP from the form, ask it for its tools, then drop the temporary session.
 * Saved secrets stay referenced by key. Newly typed values must already be stored.
 */
export async function probeMcpExtension(formData: ExtensionFormData): Promise<ProbeTool[]> {
  const extension = extensionConfigToGooseExtension(createExtensionConfig(formData));
  if (!extension || extension.type !== 'mcp') {
    throw new Error('Only MCP extensions can be tested');
  }

  const cwd = await window.electron.getHomeDir();
  const client = await getAcpClient();
  const created = (await client.connection.agent.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
    _meta: {
      hidden: true,
      client: 'goose-desktop',
      enabledExtensions: [],
    },
  })) as NewSessionResponse;
  const sessionId = String(created.sessionId);

  try {
    await client.goose.sessionExtensionsAdd_unstable({ sessionId, extension });
    const listed = await client.goose.toolsList_unstable({
      sessionId,
      extensionName: formData.name,
    });
    return (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  } finally {
    await client.goose
      .sessionExtensionsRemove_unstable({
        sessionId,
        extensionKey: nameToKey(formData.name),
      })
      .catch(() => undefined);
    await client.connection.agent
      .request(methods.agent.session.delete, { sessionId })
      .catch(() => undefined);
  }
}
