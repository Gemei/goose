#![cfg(windows)]

use goose::config::Config;

#[test]
fn secrets_file_is_sealed_with_dpapi() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.yaml");
    let secrets_path = dir.path().join("secrets.yaml");
    let config = Config::new_with_file_secrets(&config_path, &secrets_path).unwrap();

    config
        .set_secret("token", &"plain-token-value")
        .unwrap();

    let stored = std::fs::read_to_string(&secrets_path).unwrap();
    assert!(stored.starts_with("goose-dpapi-v1\n"));
    assert!(!stored.contains("plain-token-value"));

    let value: String = config.get_secret("token").unwrap();
    assert_eq!(value, "plain-token-value");
}

#[test]
fn plaintext_secrets_are_sealed_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.yaml");
    let secrets_path = dir.path().join("secrets.yaml");
    std::fs::write(&secrets_path, "token: plain-token-value\n").unwrap();

    let config = Config::new_with_file_secrets(&config_path, &secrets_path).unwrap();
    let value: String = config.get_secret("token").unwrap();
    assert_eq!(value, "plain-token-value");

    let stored = std::fs::read_to_string(&secrets_path).unwrap();
    assert!(stored.starts_with("goose-dpapi-v1\n"));
    assert!(!stored.contains("plain-token-value"));
}
