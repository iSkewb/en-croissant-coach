//! Run the coach through the Claude Code CLI (`claude -p`) so it uses your Claude
//! subscription instead of a separately billed API key.
//!
//! Every call is stripped down to keep plan usage as low as possible:
//! - a short custom system prompt instead of Claude Code's large default one
//! - no tools, no MCP servers, no skills/slash commands, no settings or CLAUDE.md loading
//! - no saved session, low effort, run in an empty scratch folder
//! - cheap model aliases by default ("haiku" for explanations, "sonnet" for pattern analysis)

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::Command};

use super::{msg, TResult, TrainingError};

const TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

/// Locate the Claude Code executable. Checks the user's override first, then the
/// standard install locations (native installer, npm global), then PATH.
pub fn find_claude(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(h) = &home {
        candidates.push(h.join(".local").join("bin").join(exe_name()));
        candidates.push(h.join(".claude").join("local").join(exe_name()));
    }
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        candidates.push(
            appdata
                .join("npm")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe"),
        );
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(exe_name()));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn friendly_error(text: &str) -> TrainingError {
    let t = text.to_lowercase();
    let hint = if t.contains("auth") || t.contains("log in") || t.contains("login") || t.contains("api key") {
        "Claude Code isn't signed in. Open Claude Code once, sign in with your Claude account, then try again."
    } else if t.contains("limit") || t.contains("quota") || t.contains("rate") {
        "You've reached your Claude plan's usage limit. Try again after it resets."
    } else {
        ""
    };
    if hint.is_empty() {
        TrainingError::Msg(format!("Claude Code error: {text}"))
    } else {
        TrainingError::Msg(format!("{hint} ({text})"))
    }
}

/// The arguments used for every call (exposed for tests).
pub fn args(model: &str, effort: &str, system: &str) -> Vec<String> {
    [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--effort",
        effort,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--system-prompt",
        system,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Parse `claude -p --output-format json` output.
pub fn parse_output(stdout: &str) -> TResult<(String, Usage)> {
    let v: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| TrainingError::Msg(format!("Unexpected Claude Code output: {}", stdout.chars().take(300).collect::<String>())))?;
    let result = v["result"].as_str().unwrap_or_default().to_string();
    if v["is_error"].as_bool().unwrap_or(false) {
        return Err(friendly_error(&result));
    }
    let u = &v["usage"];
    let usage = Usage {
        input_tokens: u["input_tokens"].as_u64().unwrap_or(0)
            + u["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
        cache_read_tokens: u["cache_read_input_tokens"].as_u64().unwrap_or(0),
    };
    if result.trim().is_empty() {
        return msg("Claude Code returned an empty answer.");
    }
    Ok((result, usage))
}

/// Send one prompt (via stdin) and return the text answer.
pub async fn run(
    exe: &Path,
    model: &str,
    effort: &str,
    system: &str,
    prompt: &str,
) -> TResult<(String, Usage)> {
    // Empty scratch folder so no project files or CLAUDE.md are picked up.
    let workdir = std::env::temp_dir().join("en-croissant-coach-cc");
    std::fs::create_dir_all(&workdir)?;

    let mut cmd = Command::new(exe);
    cmd.args(args(model, effort, system))
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| TrainingError::Msg(format!("Couldn't start Claude Code at {}: {e}", exe.display())))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| TrainingError::Msg("Claude Code took too long to answer.".into()))??;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(friendly_error(stderr.trim()));
    }
    parse_output(&stdout)
}

/// Pull the JSON object out of a model answer (tolerates ```json fences or stray text).
pub fn extract_json(text: &str) -> TResult<Value> {
    let start = text.find('{');
    let end = text.rfind('}');
    match (start, end) {
        (Some(s), Some(e)) if e > s => Ok(serde_json::from_str(&text[s..=e])?),
        _ => msg("The coach's answer wasn't valid JSON. Try again."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_and_errors() {
        let ok = r#"{"type":"result","is_error":false,"result":"Rule: check captures.","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":42}}"#;
        let (t, u) = parse_output(ok).unwrap();
        assert_eq!(t, "Rule: check captures.");
        assert_eq!(u.input_tokens, 15);
        assert_eq!(u.output_tokens, 42);

        let err = r#"{"type":"result","is_error":true,"result":"Authentication error · try again"}"#;
        let e = parse_output(err).unwrap_err().to_string();
        assert!(e.contains("isn't signed in"), "{e}");
    }

    #[test]
    fn extracts_fenced_json() {
        let v = extract_json("```json\n{\"summary\":\"x\",\"plan\":[]}\n```").unwrap();
        assert_eq!(v["summary"], "x");
        assert!(extract_json("no json").is_err());
    }

    #[test]
    fn args_disable_tools_and_context() {
        let a = args("haiku", "low", "sys");
        let s = a.join(" ");
        for f in ["--tools", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--system-prompt"] {
            assert!(s.contains(f), "missing {f}");
        }
    }
}
