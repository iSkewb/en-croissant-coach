// The daily lesson planner: decides which steps to do today, in what order, and how many
// of each. Pure and unit-tested (src/utils/tests/lessonPlan.test.ts).
//
// Order follows how practice sticks: warm up → review what's due (spaced repetition)
// → practise this week's weakness → apply it in a game → reflect on the game.

export type LessonLength = 20 | 35 | 60;
export type StepId =
    | "online"
    | "openings"
    | "warmup"
    | "review"
    | "endgame"
    | "focus"
    | "play"
    | "lookback"
    | "checkin";

/** 0 = Sunday … 6 = Saturday (JS Date#getDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type LessonSettings = {
    trainingDays: Weekday[];
    length: LessonLength;
    name: string;
};

export const DEFAULT_LESSON_SETTINGS: LessonSettings = {
    trainingDays: [1, 2, 4, 6], // Mon, Tue, Thu, Sat
    length: 35,
    name: "",
};

export type Focus = { title: string; themes: string[]; rule: string };

export type PlanInput = {
    weekday: Weekday;
    settings: LessonSettings;
    /** Train even if today is a rest day. */
    forceLesson?: boolean;
    today: {
        drillsReviewed: number;
        warmupPuzzles: number;
        focusPuzzles: number;
        maiaGames: number;
        openingReviews?: number;
        marks: string[];
        insightToday: boolean;
    };
    dueDrills: number;
    focus: Focus | null;
    maiaElo: number;
    maiaInstalled: boolean;
    puzzleDbAvailable: boolean;
    hasOnlineAccounts: boolean;
    /** Days since the last pattern analysis (null = never). */
    daysSinceInsight: number | null;
    totalMistakes: number;
    /** The endgame drill the coach would pick next (null = none available). */
    endgame?: { title: string } | null;
    /** Opening repertoire: positions due / never practised, and whether any lines exist. */
    openings?: { due: number; fresh: number; hasLines: boolean } | null;
};

export type LessonStep = {
    id: StepId;
    title: string;
    detail: string;
    minutes: number;
    target: number;
    progress: number;
    done: boolean;
    skipped: boolean;
};

export type LessonPlan = {
    kind: "lesson" | "rest";
    checkinDay: boolean;
    steps: LessonStep[];
    totalMinutes: number;
    currentId: StepId | null;
    complete: boolean;
    nextTrainingDay: Weekday | null;
};

const SIZES: Record<
    LessonLength,
    { warmup: number; review: number; focus: number; playMin: number; lookMin: number }
> = {
    20: { warmup: 0, review: 5, focus: 6, playMin: 0, lookMin: 0 },
    35: { warmup: 4, review: 6, focus: 6, playMin: 15, lookMin: 4 },
    60: { warmup: 5, review: 10, focus: 10, playMin: 25, lookMin: 6 },
};

const OPENING_SIZE: Record<LessonLength, number> = { 20: 6, 35: 8, 60: 12 };

export const WEEKDAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
/** Monday-first position of a weekday (Mon = 0 … Sun = 6). */
const mondayIndex = (d: Weekday) => (d + 6) % 7;

export function isLastTrainingDayOfWeek(day: Weekday, trainingDays: Weekday[]): boolean {
    if (!trainingDays.includes(day)) return false;
    return Math.max(...trainingDays.map(mondayIndex)) === mondayIndex(day);
}

export function nextTrainingDay(day: Weekday, trainingDays: Weekday[]): Weekday | null {
    for (let k = 1; k <= 7; k++) {
        const d = ((day + k) % 7) as Weekday;
        if (trainingDays.includes(d)) return d;
    }
    return null;
}

export function planLesson(input: PlanInput): LessonPlan {
    const { settings, today } = input;
    const sizes = SIZES[settings.length];
    const marks = new Set(today.marks);
    const trainingDay = settings.trainingDays.includes(input.weekday);
    const steps: LessonStep[] = [];

    const add = (s: Omit<LessonStep, "done" | "skipped">, doneByActivity: boolean) => {
        const skipped = marks.has(`skip:${s.id}`);
        steps.push({ ...s, skipped, done: doneByActivity || skipped });
    };

    const reviewTarget = Math.min(sizes.review, today.drillsReviewed + input.dueDrills);

    if (!trainingDay && !input.forceLesson) {
        // Rest day: offer only the reviews that are due, so nothing piles up.
        if (reviewTarget > 0) {
            add(
                {
                    id: "review",
                    title: "Optional: review your mistakes",
                    detail: `${reviewTarget} position${reviewTarget === 1 ? "" : "s"} due`,
                    minutes: Math.max(3, Math.round(reviewTarget * 1.3)),
                    target: reviewTarget,
                    progress: Math.min(today.drillsReviewed, reviewTarget),
                },
                today.drillsReviewed >= reviewTarget,
            );
        }
        return finalize("rest", false, steps, input);
    }

    if (input.hasOnlineAccounts) {
        add(
            {
                id: "online",
                title: "Catch up on your online games",
                detail: "Fetch and analyse your latest games",
                minutes: 2,
                target: 1,
                progress: marks.has("online") ? 1 : 0,
            },
            marks.has("online"),
        );
    }

    // Openings: a few repertoire positions at the start of every lesson.
    const op = input.openings;
    if (op) {
        const size = OPENING_SIZE[settings.length];
        const reviewed = today.openingReviews ?? 0;
        const doneOpen = marks.has("openings") || reviewed >= size;
        if (!op.hasLines)
            add(
                {
                    id: "openings",
                    title: "Openings",
                    detail: "Pick your repertoire to start practising it",
                    minutes: 3,
                    target: 1,
                    progress: doneOpen ? 1 : 0,
                },
                doneOpen,
            );
        else if (op.due + op.fresh > 0 || reviewed > 0 || doneOpen)
            add(
                {
                    id: "openings",
                    title: "Openings",
                    detail:
                        op.due > 0
                            ? `${op.due} position${op.due === 1 ? "" : "s"} due from your repertoire`
                            : "Learn new moves from your repertoire",
                    minutes: Math.ceil(size * 0.4) + 1,
                    target: size,
                    progress: Math.min(reviewed, size),
                },
                doneOpen,
            );
    }

    // Endgames: every lesson at 60 min, every other training day at 35 (instead of the
    // warm-up), the first training day of the week at 20 (instead of focus puzzles).
    const dayIndex = [...settings.trainingDays]
        .sort((a, b) => mondayIndex(a) - mondayIndex(b))
        .indexOf(input.weekday);
    const endgameToday =
        !!input.endgame &&
        (settings.length === 60
            ? true
            : settings.length === 35
              ? dayIndex % 2 === 1
              : dayIndex <= 0);
    const skipWarmup = endgameToday && settings.length === 35;
    const skipFocus = endgameToday && settings.length === 20;

    if (sizes.warmup > 0 && input.puzzleDbAvailable && !skipWarmup) {
        add(
            {
                id: "warmup",
                title: "Warm-up",
                detail: `${sizes.warmup} easy puzzles`,
                minutes: sizes.warmup,
                target: sizes.warmup,
                progress: Math.min(today.warmupPuzzles, sizes.warmup),
            },
            today.warmupPuzzles >= sizes.warmup,
        );
    }

    if (reviewTarget > 0) {
        add(
            {
                id: "review",
                title: "Review your mistakes",
                detail: `${reviewTarget} position${reviewTarget === 1 ? "" : "s"} from your games`,
                minutes: Math.max(3, Math.round(reviewTarget * 1.3)),
                target: reviewTarget,
                progress: Math.min(today.drillsReviewed, reviewTarget),
            },
            today.drillsReviewed >= reviewTarget,
        );
    }

    if (endgameToday && input.endgame) {
        add(
            {
                id: "endgame",
                title: "Endgame",
                detail: input.endgame.title,
                minutes: 5,
                target: 1,
                progress: marks.has("endgame") ? 1 : 0,
            },
            marks.has("endgame"),
        );
    }

    if (input.puzzleDbAvailable && !skipFocus) {
        add(
            {
                id: "focus",
                title: "Focus training",
                detail: input.focus
                    ? `${sizes.focus} puzzles on ${input.focus.title.toLowerCase()}`
                    : `${sizes.focus} mixed tactics puzzles`,
                minutes: sizes.focus + 1,
                target: sizes.focus,
                progress: Math.min(today.focusPuzzles, sizes.focus),
            },
            today.focusPuzzles >= sizes.focus,
        );
    }

    if (sizes.playMin > 0) {
        add(
            {
                id: "play",
                title: "Play a game",
                detail: input.maiaInstalled
                    ? `Maia ${input.maiaElo}${input.focus ? " · with this week's rule as your goal" : ""}`
                    : "Set up Maia on the Play tab first",
                minutes: sizes.playMin,
                target: 1,
                progress: Math.min(today.maiaGames, 1),
            },
            today.maiaGames >= 1,
        );
        add(
            {
                id: "lookback",
                title: "Look back",
                detail: "Your game's turning point, with the coach",
                minutes: sizes.lookMin,
                target: 1,
                progress: marks.has("lookback") ? 1 : 0,
            },
            marks.has("lookback"),
        );
    }

    const checkinDay =
        trainingDay &&
        input.totalMistakes >= 5 &&
        (isLastTrainingDayOfWeek(input.weekday, settings.trainingDays) ||
            input.daysSinceInsight === null ||
            input.daysSinceInsight >= 7);
    if (checkinDay) {
        const done = today.insightToday || marks.has("checkin");
        add(
            {
                id: "checkin",
                title: "Weekly check-in",
                detail: "What improved, and next week's focus",
                minutes: 3,
                target: 1,
                progress: done ? 1 : 0,
            },
            done,
        );
    }

    return finalize("lesson", checkinDay, steps, input);
}

function finalize(
    kind: LessonPlan["kind"],
    checkinDay: boolean,
    steps: LessonStep[],
    input: PlanInput,
): LessonPlan {
    const current = steps.find((s) => !s.done);
    return {
        kind,
        checkinDay,
        steps,
        totalMinutes: steps.reduce((a, s) => a + s.minutes, 0),
        currentId: current?.id ?? null,
        complete: steps.length > 0 && !current,
        nextTrainingDay: nextTrainingDay(input.weekday, input.settings.trainingDays),
    };
}

/** Consecutive completed training days ending today (today counts only once completed). */
export function streak(
    history: { date: string; lessonComplete: boolean }[],
    trainingDays: Weekday[],
): number {
    let n = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const day = new Date(`${history[i].date}T12:00:00`).getDay() as Weekday;
        if (!trainingDays.includes(day)) continue;
        if (history[i].lessonComplete) n++;
        else if (i === history.length - 1) continue; // today, not finished yet
        else break;
    }
    return n;
}
