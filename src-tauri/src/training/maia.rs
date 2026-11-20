//! Maia-3: a human-like chess engine (University of Toronto CSSLab, AGPL-3.0) that predicts
//! the move a real player of a given rating would make. It runs on Python + PyTorch, so the
//! Coach installs a private environment for it — no terminal, nothing on the system Python:
//!
//!   <root>/uv(.exe)        uv, a single-file Python package manager (downloaded)
//!   <root>/python/         a uv-managed Python 3.12
//!   <root>/venv/           virtual env with torch (CPU) + maia3 (pinned commit)
//!   <root>/models/*.pt     the Maia-3 checkpoint (downloaded from Hugging Face)
//!   <root>/installed.json  marker written after a successful smoke test
//!
//! Maia-3's Elo is on the Lichess blitz scale (600–2600).

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::process::Command;

use super::{msg, uci::UciEngine, TResult, TrainingError};

pub const UV_VERSION: &str = "0.11.32";
pub const MAIA3_COMMIT: &str = "1e13597c42d4858b7cfd7cfdae01e297263364b2";
pub const MODEL_ALIAS: &str = "5m";
pub const MODEL_FILE: &str = "maia3-5m.pt";
pub const MODEL_URL: &str = "https://huggingface.co/UofTCSSLab/Maia3-5M/resolve/main/maia3-5m.pt";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaiaStatus {
    pub installed: bool,
    pub folder: String,
    pub model: String,
}

/// What to install. `Default` is the real setup; tests override pieces.
#[derive(Debug, Clone)]
pub struct InstallSpec {
    /// Existing uv binary to use instead of downloading one.
    pub uv_override: Option<PathBuf>,
    /// pip requirement for maia3 (URL of the pinned GitHub archive by default).
    pub maia_requirement: String,
    pub python: String,
    /// "only-managed" (default: never touch a system Python) or "system" for tests.
    pub python_preference: String,
    pub model_url: String,
}

impl Default for InstallSpec {
    fn default() -> Self {
        Self {
            uv_override: None,
            maia_requirement: format!(
                "maia3 @ https://github.com/CSSLab/maia3/archive/{MAIA3_COMMIT}.zip"
            ),
            python: "3.12".into(),
            python_preference: "only-managed".into(),
            model_url: MODEL_URL.into(),
        }
    }
}

pub struct MaiaPaths {
    pub root: PathBuf,
}

impl MaiaPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    fn exe(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }
    pub fn uv(&self) -> PathBuf {
        self.root.join(Self::exe("uv"))
    }
    pub fn venv(&self) -> PathBuf {
        self.root.join("venv")
    }
    fn venv_bin(&self) -> PathBuf {
        self.venv().join(if cfg!(windows) { "Scripts" } else { "bin" })
    }
    pub fn python(&self) -> PathBuf {
        self.venv_bin().join(Self::exe("python"))
    }
    pub fn engine(&self) -> PathBuf {
        self.venv_bin().join(Self::exe("maia3-uci"))
    }
    pub fn model(&self) -> PathBuf {
        self.root.join("models").join(MODEL_FILE)
    }
    pub fn marker(&self) -> PathBuf {
        self.root.join("installed.json")
    }

    pub fn status(&self) -> MaiaStatus {
        MaiaStatus {
            installed: self.marker().is_file() && self.engine().is_file() && self.model().is_file(),
            folder: self.root.display().to_string(),
            model: MODEL_ALIAS.into(),
        }
    }

    /// Arguments for running the engine against our downloaded checkpoint (no network at runtime).
    pub fn engine_args(&self) -> Vec<String> {
        vec![
            "--model".into(),
            MODEL_ALIAS.into(),
            "--checkpoint-path".into(),
            self.model().display().to_string(),
            "--device".into(),
            "cpu".into(),
            "--use-uci-history".into(),
        ]
    }
}

fn uv_asset() -> TResult<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "uv-x86_64-pc-windows-msvc.zip",
        ("windows", "aarch64") => "uv-aarch64-pc-windows-msvc.zip",
        ("linux", "x86_64") => "uv-x86_64-unknown-linux-gnu.tar.gz",
        ("macos", "aarch64") => "uv-aarch64-apple-darwin.tar.gz",
        ("macos", "x86_64") => "uv-x86_64-apple-darwin.tar.gz",
        (os, arch) => return msg(format!("Unsupported platform for Maia-3 setup: {os}/{arch}")),
    })
}

async fn download(url: &str) -> TResult<Vec<u8>> {
    let res = reqwest::Client::new().get(url).send().await?;
    if !res.status().is_success() {
        return msg(format!("Download failed ({}): {url}", res.status()));
    }
    Ok(res.bytes().await?.to_vec())
}

/// Pull the uv binary out of the release archive.
pub fn extract_uv(archive: &[u8], asset: &str, dest: &Path) -> TResult<()> {
    let want = if asset.ends_with(".zip") { "uv.exe" } else { "uv" };
    let mut bytes = Vec::new();
    if asset.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
            .map_err(|e| TrainingError::Msg(format!("bad uv archive: {e}")))?;
        let mut found = false;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| TrainingError::Msg(e.to_string()))?;
            let name = f.name().map(|n| n.to_string()).unwrap_or_default();
            if name.rsplit('/').next() == Some(want) {
                f.read_to_end(&mut bytes)?;
                found = true;
                break;
            }
        }
        if !found {
            return msg("uv.exe not found in archive");
        }
    } else {
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(archive));
        let mut tar = tar::Archive::new(gz);
        let mut found = false;
        for entry in tar.entries()? {
            let mut e = entry?;
            let path = e.path()?.to_path_buf();
            if path.file_name().and_then(|n| n.to_str()) == Some(want) {
                e.read_to_end(&mut bytes)?;
                found = true;
                break;
            }
        }
        if !found {
            return msg("uv not found in archive");
        }
    }
    std::fs::write(dest, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// Run a setup command; on failure return the tail of its output.
async fn run(exe: &Path, args: &[String], envs: &[(String, String)]) -> TResult<()> {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = cmd
        .output()
        .await
        .map_err(|e| TrainingError::Msg(format!("couldn't run {}: {e}", exe.display())))?;
    if out.status.success() {
        return Ok(());
    }
    let mut text = String::from_utf8_lossy(&out.stderr).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stdout));
    let tail: Vec<&str> = text.lines().rev().take(12).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    msg(format!("{} failed:\n{}", exe.file_name().unwrap_or_default().to_string_lossy(), tail.join("\n")))
}

/// Start the engine and make one move as a smoke test.
pub async fn smoke_test(paths: &MaiaPaths) -> TResult<String> {
    let mut e = UciEngine::spawn_with(&paths.engine().display().to_string(), &paths.engine_args(), &[]).await?;
    e.set_option("Elo", "1100").await?;
    e.new_game().await?;
    let mv = e
        .best_move("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", &[], "nodes 1")
        .await?;
    e.quit().await;
    mv.ok_or_else(|| TrainingError::Msg("Maia-3 didn't return a move".into()))
}

/// Install everything. `progress(percent, message)` is called as steps complete.
pub async fn install(
    paths: &MaiaPaths,
    spec: &InstallSpec,
    mut progress: impl FnMut(f32, &str) + Send,
) -> TResult<()> {
    std::fs::create_dir_all(&paths.root)?;
    std::fs::create_dir_all(paths.root.join("models"))?;
    let envs = vec![
        ("UV_PYTHON_INSTALL_DIR".to_string(), paths.root.join("python").display().to_string()),
        ("UV_CACHE_DIR".to_string(), paths.root.join("cache").display().to_string()),
        ("UV_NO_CONFIG".to_string(), "1".to_string()),
    ];

    // 1. uv
    let uv = match &spec.uv_override {
        Some(p) => p.clone(),
        None => {
            if !paths.uv().is_file() {
                progress(2.0, "Downloading the Python package manager (uv)…");
                let asset = uv_asset()?;
                let url = format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{asset}");
                let bytes = download(&url).await?;
                extract_uv(&bytes, asset, &paths.uv())?;
            }
            paths.uv()
        }
    };

    // 2. Python + virtual environment
    if !paths.python().is_file() {
        progress(8.0, "Setting up a private Python 3.12…");
        run(
            &uv,
            &[
                "venv".into(),
                "--python".into(),
                spec.python.clone(),
                "--python-preference".into(),
                spec.python_preference.clone(),
                paths.venv().display().to_string(),
            ],
            &envs,
        )
        .await?;
    }

    // 3. PyTorch (CPU) + Maia-3
    if !paths.engine().is_file() {
        progress(20.0, "Installing PyTorch and Maia-3 (about 200 MB download; a few minutes)…");
        run(
            &uv,
            &[
                "pip".into(),
                "install".into(),
                "--python".into(),
                paths.python().display().to_string(),
                "torch".into(),
                spec.maia_requirement.clone(),
            ],
            &envs,
        )
        .await?;
    }

    // 4. Model weights
    if !paths.model().is_file() {
        progress(85.0, "Downloading the Maia-3 model…");
        let bytes = download(&spec.model_url).await?;
        let tmp = paths.model().with_extension("part");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, paths.model())?;
    }

    // 5. Smoke test
    progress(95.0, "Testing the engine…");
    let mv = smoke_test(paths).await?;
    std::fs::write(
        paths.marker(),
        serde_json::to_string_pretty(&serde_json::json!({
            "maia3_commit": MAIA3_COMMIT,
            "model": MODEL_FILE,
            "uv": UV_VERSION,
            "first_move": mv,
        }))?,
    )?;
    // The download cache is only needed during setup.
    let _ = std::fs::remove_dir_all(paths.root.join("cache"));
    progress(100.0, "Ready");
    Ok(())
}

/// Lichess-blitz-scale starting level from a Chess.com-style game rating.
/// Rough conversion: Lichess blitz ≈ Chess.com rapid + 350 at club level.
pub fn suggested_start_elo(game_rating: Option<i32>) -> i32 {
    let r = game_rating.map(|r| r + 350).unwrap_or(1100);
    ((r as f32 / 50.0).round() as i32 * 50).clamp(600, 2600)
}

/// Next level after recent results at the current level (scores: 1 win, 0.5 draw, 0 loss).
pub fn next_elo(current: i32, recent_scores: &[f32]) -> i32 {
    if recent_scores.len() < 3 {
        return current;
    }
    let last3: f32 = recent_scores.iter().rev().take(3).sum();
    let next = if last3 >= 2.0 {
        current + 50
    } else if last3 <= 0.5 {
        current - 50
    } else {
        current
    };
    next.clamp(600, 2600)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels() {
        assert_eq!(suggested_start_elo(Some(750)), 1100);
        assert_eq!(suggested_start_elo(None), 1100);
        assert_eq!(suggested_start_elo(Some(100)), 600);
        assert_eq!(next_elo(1100, &[1.0, 1.0, 0.0]), 1150);
        assert_eq!(next_elo(1100, &[0.0, 0.5, 0.0]), 1050);
        assert_eq!(next_elo(1100, &[1.0, 0.0, 0.5]), 1100);
        assert_eq!(next_elo(1100, &[1.0, 1.0]), 1100, "needs 3 games");
    }

    #[test]
    fn engine_args_use_local_checkpoint() {
        let p = MaiaPaths::new("/x/maia3");
        let a = p.engine_args().join(" ");
        assert!(a.contains("--checkpoint-path /x/maia3/models/maia3-5m.pt"));
        assert!(a.contains("--use-uci-history"));
        assert!(!p.status().installed);
    }
}
