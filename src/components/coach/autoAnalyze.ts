import { resolve } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { getDefaultStore } from "jotai";
import { enginesAtom, sessionsAtom } from "@/state/atoms";
import { getDatabasesDir } from "@/utils/directories";
import type { LocalEngine } from "@/utils/engines";
import { coachIngestSettingsAtom, type IngestSummary, training } from "@/utils/training";

export type AccountRef = { username: string; site: "chesscom" | "lichess" };

/** Accounts connected on the Accounts page. */
export function connectedAccounts(): AccountRef[] {
    const sessions = getDefaultStore().get(sessionsAtom);
    const out: AccountRef[] = [];
    for (const s of sessions) {
        if (s.chessCom?.username) out.push({ username: s.chessCom.username, site: "chesscom" });
        if (s.lichess?.username) out.push({ username: s.lichess.username, site: "lichess" });
    }
    return out;
}

function pickEngine(engineId: string): LocalEngine | null {
    const engines = getDefaultStore().get(enginesAtom) ?? [];
    const local = engines.filter((e): e is LocalEngine => e.type === "local");
    return local.find((e) => e.id === engineId) ?? local[0] ?? null;
}

/**
 * Analyse the PGN that "Download games" just wrote for one account.
 * Only new games are analysed (already-analysed games are skipped by id).
 */
export async function analyzeAccount(acc: AccountRef): Promise<IngestSummary | null> {
    const settings = getDefaultStore().get(coachIngestSettingsAtom);
    const engine = pickEngine(settings.engineId);
    if (!engine) throw new Error("Install an engine (e.g. Stockfish) on the Engines page first.");
    const file = await resolve(await getDatabasesDir(), `${acc.username}_${acc.site}.pgn`);
    if (!(await exists(file))) return null;
    return training.ingest(file, {
        enginePath: engine.path,
        player: acc.username,
        depth: settings.depth,
        threads: settings.threads,
        hashMb: settings.hashMb,
        maxGames: settings.maxGames,
        minPlies: 10,
    });
}

/** Hook for the Accounts page: called right after games are downloaded. */
export async function autoAnalyzeAfterDownload(acc: AccountRef) {
    const settings = getDefaultStore().get(coachIngestSettingsAtom);
    if (!settings.autoAnalyze) return;
    try {
        await analyzeAccount(acc);
    } catch (e) {
        console.error("Coach auto-analysis failed", e);
    }
}
