use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn piped_login_does_not_run_terminal_echo_commands() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_iphone-control"))
        .arg("login")
        .env("IPHONE_CONTROL_LANG", "en")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // End stdin before the password to exercise the prompt without contacting Apple.
    child.stdin.take().unwrap().write_all(b"test@example.invalid\n").unwrap();
    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success());
    assert!(stderr.contains("stdin is closed"), "{stderr}");
    assert!(!stderr.contains("stty"), "piped browser input tried to configure a terminal: {stderr}");
}
