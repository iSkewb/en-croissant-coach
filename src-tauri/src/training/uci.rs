//! Minimal async UCI client for batch analysis (kept separate from the app's
//! interactive engine manager so background training never fights the analysis panel).

use std::process::Stdio;

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use super::{features::EngineScore, features::EvalLine, msg, TResult};

pub struct UciEngine {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    multipv: u32,
}

impl UciEngine {
    pub async fn spawn(path: &str, threads: u32, hash_mb: u32) -> TResult<Self> {
        let mut cmd = Command::new(path);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(dir) = std::path::Path::new(path).parent() {
            if dir.is_dir() {
                cmd.current_dir(dir);
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| super::TrainingError::Msg("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| super::TrainingError::Msg("no stdout".into()))?;
        let mut e = Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            multipv: 1,
        };
        e.send("uci").await?;
        e.wait_for("uciok").await?;
        e.send(&format!("setoption name Threads value {}", threads.max(1))).await?;
        e.send(&format!("setoption name Hash value {}", hash_mb.max(16))).await?;
        e.send("ucinewgame").await?;
        e.ready().await?;
        Ok(e)
    }

    async fn send(&mut self, cmd: &str) -> TResult<()> {
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn wait_for(&mut self, token: &str) -> TResult<()> {
        while let Some(line) = self.lines.next_line().await? {
            if line.trim() == token {
                return Ok(());
            }
        }
        msg(format!("engine exited while waiting for {token}"))
    }

    async fn ready(&mut self) -> TResult<()> {
        self.send("isready").await?;
        self.wait_for("readyok").await
    }

    /// Analyse `start_fen` + `moves` to `depth`, returning up to `multipv` lines, best first.
    /// Scores are from the side to move's point of view.
    pub async fn analyse(
        &mut self,
        start_fen: &str,
        moves: &[String],
        depth: u32,
        multipv: u32,
    ) -> TResult<Vec<EvalLine>> {
        if multipv != self.multipv {
            self.send(&format!("setoption name MultiPV value {multipv}")).await?;
            self.multipv = multipv;
        }
        let mut pos_cmd = format!("position fen {start_fen}");
        if !moves.is_empty() {
            pos_cmd.push_str(" moves ");
            pos_cmd.push_str(&moves.join(" "));
        }
        self.send(&pos_cmd).await?;
        self.send(&format!("go depth {depth}")).await?;

        let mut best: Vec<Option<EvalLine>> = vec![None; multipv as usize];
        while let Some(line) = self.lines.next_line().await? {
            if line.starts_with("bestmove") {
                return Ok(best.into_iter().flatten().collect());
            }
            if let Some((k, l)) = parse_info(&line) {
                if (1..=multipv as usize).contains(&k) {
                    best[k - 1] = Some(l);
                }
            }
        }
        msg("engine exited during analysis")
    }

    pub async fn quit(mut self) {
        let _ = self.send("quit").await;
        let _ = self.child.wait().await;
    }
}

/// Parse a UCI `info` line into (multipv index, line). Ignores bound-only scores.
pub fn parse_info(line: &str) -> Option<(usize, EvalLine)> {
    let mut it = line.split_whitespace();
    if it.next()? != "info" {
        return None;
    }
    let toks: Vec<&str> = it.collect();
    let mut multipv = 1usize;
    let mut score = None;
    let mut pv = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "multipv" => {
                multipv = toks.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            "score" => {
                let kind = *toks.get(i + 1)?;
                let val: i32 = toks.get(i + 2)?.parse().ok()?;
                score = Some(match kind {
                    "cp" => EngineScore::Cp(val),
                    "mate" => EngineScore::Mate(val),
                    _ => return None,
                });
                i += 3;
                if matches!(toks.get(i), Some(&"lowerbound") | Some(&"upperbound")) {
                    return None;
                }
            }
            "pv" => {
                pv = toks[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => i += 1,
        }
    }
    if pv.is_empty() {
        return None;
    }
    Some((multipv, EvalLine { score: score?, pv }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_info_lines() {
        let (k, l) = parse_info(
            "info depth 14 seldepth 20 multipv 2 score cp -35 nodes 1 nps 1 pv e7e5 g1f3 b8c6",
        )
        .unwrap();
        assert_eq!(k, 2);
        assert_eq!(l.score, EngineScore::Cp(-35));
        assert_eq!(l.pv, vec!["e7e5", "g1f3", "b8c6"]);
        let (_, m) = parse_info("info depth 9 score mate -3 pv a1a2").unwrap();
        assert_eq!(m.score, EngineScore::Mate(-3));
        assert!(parse_info("info depth 9 score cp 20 lowerbound pv a1a2").is_none());
        assert!(parse_info("info string NNUE enabled").is_none());
    }
}
