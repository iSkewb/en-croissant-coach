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

export type CoachSettingsView = {
    hasApiKey: boolean;
    model: string;
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
    setSettings: (apiKey: string | null, model: string, autoInsightEvery: number) =>
        invoke<void>("training_set_settings", { apiKey, model, autoInsightEvery }),
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
