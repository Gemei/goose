//! File-backed secrets.
//!
//! On Windows the YAML is sealed with DPAPI (`CryptProtectData`) for the
//! current user before it is written. Other users on the machine cannot
//! decrypt it. Older plaintext files are still read, then rewritten sealed.

use std::io;

use base64::{engine::general_purpose::STANDARD, Engine as _};

const HEADER: &str = "goose-dpapi-v1";
/// Binds the ciphertext to this application. It is not a password.
const ENTROPY: &[u8] = b"goose-secrets-v1";

#[derive(Debug)]
pub(super) struct DecodedSecrets {
    pub yaml: String,
    /// True when the file was legacy plaintext and should be rewritten sealed.
    pub was_plaintext: bool,
}

pub(super) fn encode_secrets_file(yaml: &str) -> io::Result<String> {
    #[cfg(windows)]
    {
        let sealed = dpapi_protect(yaml.as_bytes())?;
        Ok(format!("{HEADER}\n{}\n", STANDARD.encode(sealed)))
    }
    #[cfg(not(windows))]
    {
        Ok(yaml.to_string())
    }
}

pub(super) fn decode_secrets_file(raw: &str) -> io::Result<DecodedSecrets> {
    let raw = raw.trim_start_matches('\u{feff}');
    let Some(payload) = header_payload(raw) else {
        return Ok(DecodedSecrets {
            yaml: raw.to_string(),
            was_plaintext: cfg!(windows),
        });
    };

    let blob = STANDARD
        .decode(payload.trim().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let plain = dpapi_unprotect(&blob)?;
    let yaml = String::from_utf8(plain)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(DecodedSecrets {
        yaml,
        was_plaintext: false,
    })
}

fn header_payload(raw: &str) -> Option<&str> {
    let (header, payload) = raw.split_once(['\n', '\r'])?;
    if header.trim() != HEADER {
        return None;
    }
    Some(payload.trim_start_matches('\n').trim_start_matches('\r'))
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> io::Result<Vec<u8>> {
    dpapi_call(plain, true)
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> io::Result<Vec<u8>> {
    dpapi_call(blob, false)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "DPAPI secrets can only be read on Windows",
    ))
}

#[cfg(windows)]
fn dpapi_call(input: &[u8], protect: bool) -> io::Result<Vec<u8>> {
    use std::ptr;

    use winapi::shared::minwindef::{DWORD, HLOCAL};
    use winapi::um::dpapi::{CryptProtectData, CryptUnprotectData};
    use winapi::um::wincrypt::DATA_BLOB;
    use winapi::um::winbase::LocalFree;

    const CRYPTPROTECT_UI_FORBIDDEN: DWORD = 0x1;

    let len = DWORD::try_from(input.len()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "secret is too large for DPAPI")
    })?;
    let entropy_len = DWORD::try_from(ENTROPY.len()).expect("entropy fits in a DWORD");
    let mut data_in = DATA_BLOB {
        cbData: len,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut entropy = DATA_BLOB {
        cbData: entropy_len,
        pbData: ENTROPY.as_ptr() as *mut u8,
    };
    let mut data_out = DATA_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        if protect {
            CryptProtectData(
                &mut data_in,
                ptr::null(),
                &mut entropy,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        } else {
            CryptUnprotectData(
                &mut data_in,
                ptr::null_mut(),
                &mut entropy,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        }
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    let sealed = unsafe {
        let bytes = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize).to_vec();
        LocalFree(data_out.pbData as HLOCAL);
        bytes
    };
    Ok(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_secrets_stay_readable() {
        let decoded = decode_secrets_file("token: secret-value\n").unwrap();
        assert_eq!(decoded.yaml, "token: secret-value\n");
        assert_eq!(decoded.was_plaintext, cfg!(windows));
    }

    #[test]
    #[cfg(windows)]
    fn dpapi_round_trip_hides_the_secret() {
        let yaml = "oauth_creds_Notion: \"plain-token-value\"\n";
        let stored = encode_secrets_file(yaml).unwrap();
        assert!(stored.starts_with("goose-dpapi-v1\n"));
        assert!(!stored.contains("plain-token-value"));
        let decoded = decode_secrets_file(&stored).unwrap();
        assert_eq!(decoded.yaml, yaml);
        assert!(!decoded.was_plaintext);
    }

    #[test]
    fn malformed_dpapi_payload_is_rejected() {
        let error = decode_secrets_file("goose-dpapi-v1\n@@@\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
