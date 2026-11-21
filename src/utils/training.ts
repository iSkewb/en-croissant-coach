// Typed wrappers for the Coach (training) Tauri commands + FSRS scheduling for mistake drills.
// Written against `invoke` directly so it doesn't depend on regenerated bindings.
import { invoke } from "@tauri-apps/api/core";
import { atomWithStorage } from "jotai/utils";
import { type Card, createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";

export const INGEST_PROGRESS_ID = "training_ingest";

export type Mistake = {
    id: number;
    gameId: string;
    ply: number;
    fenBefore: string;
    playerColor: "white" | "black";
    playedUci: string;
    playedSan: string;
    bestUci: string;
    bestSan: string;
    bestLine: string;
    refutationLine: string;
    evalBeforeCp: number;
    evalAfterCp: number;
    winBefore: number;
    winAfter: number;
    winDrop: number;
    severity: "inaccuracy" | "mistake" | "blunder";
    phase: "opening" | "middlegame" | "endgame";
    movedRole: string;
    clockSecs: number | null;
    timeSpentSecs: number | null;
    tags: string[];
    secondUci: string | null;
    secondCp: number | null;
    opponent: string;
    opening: string | null;
    timeControl: string | null;
    date: string | null;
    url: string | null;
};

export type CountRow = { key: string; count: number };
export type MonthlyRate = { month: string; games: number; mistakesPerGame: number };

export type TrainingStats = {
    games: number;
    mistakes: number;
    blunders: number;
    mistakesPerGame: number;
    byTag: CountRow[];
    byPhase: CountRow[];
    byOpening: CountRow[];
    byTimeControl: CountRow[];
    byPiece: CountRow[];
    monthlyRate: MonthlyRate[];
    cardsDue: number;
    cardsTotal: number;
};

export type Weakness = {
    title: string;
    evidence: string;
    ruleOfThumb: string;
    mistakeIds: number[];
    drillTags: string[];
    puzzleThemes: string[];
    priority: number;
};

export type TodayCounts = {
    date: string;
    drillsReviewed: number;
    warmupPuzzles: number;
    focusPuzzles: number;
    maiaGames: number;
    gamesAnalyzed: number;
    marks: string[];
    insightToday: boolean;
    latestInsightDate: string | null;
};

export type DayActivity = {
    date: string;
    lessonComplete: boolean;
    drills: number;
    puzzles: number;
    games: number;
};

export type Insight = {
    id: number;
    createdAt: string;
    mistakesAnalyzed: number;
    summary: string;
    weaknesses: Weakness[];
    strengths: string[];
    plan: string[];
    progressNote: string;
};

export type DrillLine = { cp: number; mate: number | null; pvUci: string[]; pvSan: string[] };

export type MistakeContext = {
    prevFen: string | null;
    prevMoveUci: string | null;
    prevMoveSan: string | null;
    gameContinuationUci: string[];
    gameContinuationSan: string[];
    startFen: string | null;
    allMovesSan: string[];
};

export type CoachPuzzle = {
    id: number;
    fen: string;
    /** moves[0] is the opponent's setup move; you play moves[1], moves[3], ... */
    moves: string[];
    rating: number;
    themes: string[];
};

export type PuzzleAttempt = {
    puzzleId: number;
    rating: number;
    themes: string[];
    weakness: string | null;
    solved: boolean;
    hints: number;
    seconds: number;
};

export type ThemeStat = {
    theme: string;
    attempts: number;
    solved: number;
    recentAttempts: number;
    recentSolved: number;
};

export type PuzzleProfile = {
    rating: number;
    attempts: number;
    solved: number;
    themeStats: ThemeStat[];
};

export type MaiaStatus = { installed: boolean; folder: string; model: string };

export type MaiaGameRecord = {
    gameId: string;
    color: "white" | "black";
    elo: number;
    result: "win" | "loss" | "draw";
    plies: number;
    opening: string | null;
    hints: number;
    takebacks: number;
    timeControl: string | null;
    pgn: string;
};

export type MaiaSummary = {
    games: number;
    wins: number;
    draws: number;
    losses: number;
    suggestedElo: number;
    byLevel: { elo: number; games: number; wins: number; draws: number; losses: number }[];
    openings: { name: string; color: string; games: number; score: number }[];
    recent: {
        date: string;
        color: string;
        elo: number;
        result: string;
        opening: string | null;
        gameId: string;
    }[];
};

export const MAIA_INSTALL_PROGRESS_ID = "maia_install";

export type DrillCard = { mistake: Mistake; cardJson: string | null; focus: boolean };

export type IngestOptions = {
    enginePath: string;
    player: string;
    depth: number;
    threads: number;
    hashMb: number;
    maxGames: number | null;
    minPlies: number;
};

export type IngestSummary = {
    gamesSeen: number;
    gamesAnalyzed: number;
    gamesSkipped: number;
    mistakesFound: number;
    cancelled: boolean;
    insightRefreshed: boolean;
};

export type CoachProvider = "claudeCode" | "api";

export type CoachSettingsView = {
    provider: CoachProvider;
    hasApiKey: boolean;
    model: string;
    claudePath: string | null;
    detectedClaudePath: string | null;
    explainModel: string;
    insightModel: string;
    autoInsightEvery: number;
    usage7d: { calls: number; inputTokens: number; outputTokens: number };
};

export type CoachSettingsUpdate = {
    provider: CoachProvider;
    /** null keeps the saved key, "" removes it */
    apiKey: string | null;
    model: string;
    claudePath: string | null;
    explainModel: string;
    insightModel: string;
    autoInsightEvery: number;
};

export type MistakeFilter = {
    tag?: string | null;
    phase?: string | null;
    severity?: string | null;
    limit?: number | null;
};

export const training = {
    ingest: (pgnPath: string, options: IngestOptions) =>
        invoke<IngestSummary>("training_ingest", { pgnPath, options }),
    cancelIngest: () => invoke<void>("cancel_analysis", { id: INGEST_PROGRESS_ID }),
    stats: () => invoke<TrainingStats>("training_stats"),
    mistakes: (filter: MistakeFilter = {}) => invoke<Mistake[]>("training_mistakes", { filter }),
    analyse: (enginePath: string, fen: string, depth = 14, multipv = 1) =>
        invoke<DrillLine[]>("training_analyse", { enginePath, fen, depth, multipv }),
    mistakeContext: (mistakeId: number) =>
        invoke<MistakeContext>("training_mistake_context", { mistakeId }),
    themedPuzzles: (
        file: string,
        themes: string[],
        minRating: number,
        maxRating: number,
        count = 10,
    ) =>
        invoke<CoachPuzzle[]>("training_themed_puzzles", {
            file,
            themes,
            minRating,
            maxRating,
            count,
        }),
    recordPuzzle: (attempt: PuzzleAttempt) =>
        invoke<PuzzleProfile>("training_record_puzzle", { attempt }),
    puzzleProfile: () => invoke<PuzzleProfile>("training_puzzle_profile"),
    maiaStatus: () => invoke<MaiaStatus>("training_maia_status"),
    maiaInstall: () => invoke<MaiaStatus>("training_maia_install"),
    maiaUninstall: () => invoke<MaiaStatus>("training_maia_uninstall"),
    maiaMove: (startFen: string, moves: string[], elo: number) =>
        invoke<string | null>("training_maia_move", { startFen, moves, elo }),
    maiaRecordGame: (game: MaiaGameRecord) => invoke<string>("training_maia_record_game", { game }),
    maiaSummary: () => invoke<MaiaSummary>("training_maia_summary"),
    today: (tzOffsetMinutes: number) => invoke<TodayCounts>("training_today", { tzOffsetMinutes }),
    history: (days: number, tzOffsetMinutes: number) =>
        invoke<DayActivity[]>("training_history", { days, tzOffsetMinutes }),
    setMark: (date: string, mark: string, on: boolean) =>
        invoke<void>("training_set_mark", { date, mark, on }),
    lookbackMistake: (tzOffsetMinutes: number) =>
        invoke<Mistake | null>("training_lookback_mistake", { tzOffsetMinutes }),
    mistake: (id: number) => invoke<Mistake | null>("training_mistake", { id }),
    drillQueue: (limit = 20, newLimit = 10) =>
        invoke<DrillCard[]>("training_drill_queue", { limit, newLimit }),
    saveCard: (mistakeId: number, cardJson: string, dueIso: string, lapse: boolean) =>
        invoke<void>("training_save_card", { mistakeId, cardJson, dueIso, lapse }),
    facts: (mistakeId: number) => invoke<string[]>("training_facts", { mistakeId }),
    explain: (mistakeId: number, refresh = false) =>
        invoke<string>("training_explain", { mistakeId, refresh }),
    runInsights: () => invoke<Insight | null>("training_run_insights"),
    latestInsight: () => invoke<Insight | null>("training_latest_insight"),
    getSettings: () => invoke<CoachSettingsView>("training_get_settings"),
    setSettings: (update: CoachSettingsUpdate) => invoke<void>("training_set_settings", { update }),
    tagGlossary: () => invoke<[string, string][]>("training_tag_glossary"),
};

/** Where/how batch analysis runs. Persisted in localStorage. */
export const coachIngestSettingsAtom = atomWithStorage("coach-ingest-settings", {
    engineId: "",
    depth: 14,
    threads: 2,
    hashMb: 128,
    maxGames: 50 as number | null,
    /** Analyse automatically right after "Download games" on the accounts page. */
    autoAnalyze: true,
});

export const TAG_LABELS: Record<string, string> = {
    hung_piece: "Hung a piece",
    moved_piece_en_prise: "Moved piece en prise",
    ignored_threat: "Ignored a threat",
    removed_defender: "Removed a defender",
    allowed_fork: "Allowed a fork",
    allowed_mate: "Allowed mate",
    allowed_king_attack: "Allowed a king attack",
    missed_mate: "Missed mate",
    missed_fork: "Missed a fork",
    missed_free_piece: "Missed a free piece",
    lost_material: "Lost material",
    missed_material: "Missed winning material",
    positional: "Positional",
    was_winning: "While winning",
    was_losing: "While losing",
    time_pressure: "Time pressure",
    rushed: "Rushed (≤3s)",
};

export const tagLabel = (t: string) => TAG_LABELS[t] ?? t;

/** Hint shown at step 2 of the hint ladder, based on the verified tags. */
export function tagHint(tags: string[]): string {
    if (tags.includes("missed_mate")) return "There's a forced mate. Start with checks.";
    if (tags.includes("missed_fork")) return "One piece can attack two targets at once.";
    if (tags.includes("missed_free_piece"))
        return "Something of theirs is loose. Count attackers and defenders.";
    if (tags.includes("ignored_threat")) return "What is your opponent threatening right now?";
    if (tags.includes("allowed_mate")) return "Check your king's safety before anything else.";
    if (tags.includes("allowed_fork")) return "Make sure your pieces can't be hit two at a time.";
    if (tags.includes("hung_piece") || tags.includes("moved_piece_en_prise"))
        return "Before moving, ask: what can they capture after this?";
    if (tags.includes("missed_material")) return "There's a way to win material here.";
    return "Find the most purposeful move: improve your worst piece or fix a weakness.";
}

// ---------- FSRS (same library + parameters style as the repertoire trainer) ----------

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

function reviveCard(json: string | null): Card {
    if (!json) return createEmptyCard();
    const raw = JSON.parse(json);
    return {
        ...raw,
        due: new Date(raw.due),
        last_review: raw.last_review ? new Date(raw.last_review) : undefined,
    } as Card;
}

/** Grade a drill attempt and persist the new schedule. */
export async function gradeDrill(
    drill: DrillCard,
    result: "correct" | "correct_with_hint" | "wrong",
): Promise<Date> {
    const rating =
        result === "correct"
            ? Rating.Good
            : result === "correct_with_hint"
              ? Rating.Hard
              : Rating.Again;
    const card = reviveCard(drill.cardJson);
    const next = scheduler.repeat(card, new Date())[rating].card;
    await training.saveCard(
        drill.mistake.id,
        JSON.stringify(next),
        next.due.toISOString(),
        rating === Rating.Again,
    );
    return next.due;
}

export function formatEval(cp: number): string {
    if (Math.abs(cp) >= 1000) return cp > 0 ? "winning" : "lost";
    const v = cp / 100;
    return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

/** Most informative pattern first; used to show one plain label per mistake. */
const LABEL_PRIORITY: [string, string][] = [
    ["missed_mate", "Missed a mate"],
    ["allowed_mate", "Allowed mate"],
    ["moved_piece_en_prise", "Moved a piece where it could be taken"],
    ["ignored_threat", "Missed their threat"],
    ["removed_defender", "Took away a defender"],
    ["hung_piece", "Left a piece loose"],
    ["allowed_fork", "Allowed a fork"],
    ["missed_fork", "Missed a fork"],
    ["missed_free_piece", "Missed a free piece"],
    ["allowed_king_attack", "Walked into an attack"],
    ["lost_material", "Lost material"],
    ["missed_material", "Missed winning material"],
    ["positional", "Positional slip"],
];

/** One plain-language label for a mistake (instead of a row of tags). */
export function primaryLabel(tags: string[]): string {
    for (const [tag, label] of LABEL_PRIORITY) if (tags.includes(tag)) return label;
    return "Mistake";
}

/** Short context like "while winning · 2s on the move" (or null). */
export function mistakeContextLine(tags: string[], secs: number | null): string | null {
    const bits: string[] = [];
    if (tags.includes("was_winning")) bits.push("while winning");
    if (tags.includes("was_losing")) bits.push("while losing");
    if (tags.includes("time_pressure")) bits.push("short on time");
    if (tags.includes("rushed") || (secs != null && secs <= 3))
        bits.push(`${Math.round(secs ?? 0)}s on the move`);
    return bits.length ? bits.join(" · ") : null;
}

export const PLAIN_LABELS: Record<string, string> = Object.fromEntries(LABEL_PRIORITY);
