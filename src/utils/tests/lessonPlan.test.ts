import { describe, expect, test } from "vitest";
import { coachMessage, stepIntro } from "@/components/coach/lesson/coachVoice";
import {
    DEFAULT_LESSON_SETTINGS,
    isLastTrainingDayOfWeek,
    nextTrainingDay,
    type PlanInput,
    planLesson,
    streak,
} from "@/components/coach/lesson/lessonPlan";

const base: PlanInput = {
    weekday: 1, // Monday (a training day by default)
    settings: DEFAULT_LESSON_SETTINGS,
    today: {
        drillsReviewed: 0,
        warmupPuzzles: 0,
        focusPuzzles: 0,
        maiaGames: 0,
        marks: [],
        insightToday: false,
    },
    dueDrills: 9,
    focus: {
        title: "Loose pieces",
        themes: ["hangingPiece"],
        rule: "before you move, ask what they can take.",
    },
    maiaElo: 1100,
    maiaInstalled: true,
    puzzleDbAvailable: true,
    hasOnlineAccounts: false,
    daysSinceInsight: 2,
    totalMistakes: 40,
};

describe("planLesson", () => {
    test("35-minute lesson in learning order", () => {
        const p = planLesson(base);
        expect(p.kind).toBe("lesson");
        expect(p.steps.map((s) => s.id)).toEqual(["warmup", "review", "focus", "play", "lookback"]);
        expect(p.steps.find((s) => s.id === "review")!.target).toBe(6); // capped
        expect(p.totalMinutes).toBeGreaterThanOrEqual(33);
        expect(p.totalMinutes).toBeLessThanOrEqual(40);
        expect(p.currentId).toBe("warmup");
        expect(p.steps.find((s) => s.id === "play")!.detail).toContain("Maia 1100");
    });

    test("steps tick off from activity, marks and skips", () => {
        const p = planLesson({
            ...base,
            dueDrills: 2,
            today: {
                drillsReviewed: 4,
                warmupPuzzles: 4,
                focusPuzzles: 3,
                maiaGames: 0,
                marks: ["skip:focus"],
                insightToday: false,
            },
        });
        const by = Object.fromEntries(p.steps.map((s) => [s.id, s]));
        expect(by.warmup.done).toBe(true);
        expect(by.review.target).toBe(6); // 4 done + 2 due
        expect(by.review.done).toBe(false);
        expect(by.focus).toMatchObject({ done: true, skipped: true, progress: 3 });
        expect(p.currentId).toBe("review");
    });

    test("nothing due -> no review step; whole lesson completes", () => {
        const p = planLesson({
            ...base,
            dueDrills: 0,
            today: {
                drillsReviewed: 0,
                warmupPuzzles: 4,
                focusPuzzles: 6,
                maiaGames: 1,
                marks: ["lookback"],
                insightToday: false,
            },
        });
        expect(p.steps.map((s) => s.id)).not.toContain("review");
        expect(p.complete).toBe(true);
        expect(p.currentId).toBeNull();
    });

    test("20 and 60 minute lessons", () => {
        const short = planLesson({ ...base, settings: { ...base.settings, length: 20 } });
        expect(short.steps.map((s) => s.id)).toEqual(["review", "focus"]);
        const long = planLesson({ ...base, settings: { ...base.settings, length: 60 } });
        expect(long.steps.find((s) => s.id === "focus")!.target).toBe(10);
        expect(long.totalMinutes).toBeGreaterThan(50);
    });

    test("rest day offers only due reviews; can train anyway", () => {
        const rest = planLesson({ ...base, weekday: 3 }); // Wednesday
        expect(rest.kind).toBe("rest");
        expect(rest.steps.map((s) => s.id)).toEqual(["review"]);
        expect(rest.nextTrainingDay).toBe(4);
        expect(planLesson({ ...base, weekday: 3, forceLesson: true }).kind).toBe("lesson");
    });

    test("weekly check-in on the last training day, and online catch-up first", () => {
        const sat = planLesson({ ...base, weekday: 6, hasOnlineAccounts: true });
        expect(sat.checkinDay).toBe(true);
        expect(sat.steps[0].id).toBe("online");
        expect(sat.steps.at(-1)!.id).toBe("checkin");
        const done = planLesson({
            ...base,
            weekday: 6,
            today: { ...base.today, insightToday: true },
        });
        expect(done.steps.find((s) => s.id === "checkin")!.done).toBe(true);
        // never analysed yet -> check-in on any training day once there's data
        expect(planLesson({ ...base, daysSinceInsight: null }).checkinDay).toBe(true);
        expect(planLesson({ ...base, daysSinceInsight: null, totalMistakes: 2 }).checkinDay).toBe(
            false,
        );
    });

    test("no puzzle database or Maia", () => {
        const p = planLesson({ ...base, puzzleDbAvailable: false, maiaInstalled: false });
        expect(p.steps.map((s) => s.id)).toEqual(["review", "play", "lookback"]);
        expect(p.steps.find((s) => s.id === "play")!.detail).toContain("Set up Maia");
    });
});

test("endgames rotate in by lesson length", () => {
    const eg = { ...base, endgame: { title: "Queen checkmate" } };
    // 35 min, default days Mon/Tue/Thu/Sat: Tue and Sat swap the warm-up for an endgame.
    expect(planLesson(eg).steps.map((s) => s.id)).not.toContain("endgame");
    const tue = planLesson({ ...eg, weekday: 2 }).steps.map((s) => s.id);
    expect(tue).toEqual(["review", "endgame", "focus", "play", "lookback"]);
    expect(planLesson({ ...eg, weekday: 6 }).steps.map((s) => s.id)).toContain("endgame");
    // 60 min: every lesson; 20 min: first training day only, instead of focus puzzles.
    const sixty = { ...eg, settings: { ...eg.settings, length: 60 as const } };
    expect(planLesson(sixty).steps.map((s) => s.id)).toContain("warmup");
    expect(planLesson(sixty).steps.map((s) => s.id)).toContain("endgame");
    const twenty = { ...eg, settings: { ...eg.settings, length: 20 as const } };
    expect(planLesson(twenty).steps.map((s) => s.id)).toEqual(["review", "endgame"]);
    expect(planLesson({ ...twenty, weekday: 2 }).steps.map((s) => s.id)).toEqual([
        "review",
        "focus",
    ]);
    // Done via the "endgame" mark; no drill available -> no step.
    const done = planLesson({ ...eg, weekday: 2, today: { ...base.today, marks: ["endgame"] } });
    expect(done.steps.find((s) => s.id === "endgame")!.done).toBe(true);
    expect(planLesson({ ...base, weekday: 2 }).steps.map((s) => s.id)).not.toContain("endgame");
});

test("schedule helpers", () => {
    const days = DEFAULT_LESSON_SETTINGS.trainingDays; // Mon Tue Thu Sat
    expect(isLastTrainingDayOfWeek(6, days)).toBe(true);
    expect(isLastTrainingDayOfWeek(4, days)).toBe(false);
    expect(isLastTrainingDayOfWeek(0, [0, 1])).toBe(true); // Sunday ends a Monday-first week
    expect(nextTrainingDay(6, days)).toBe(1);
    expect(nextTrainingDay(2, days)).toBe(4);
});

test("streak skips rest days and an unfinished today", () => {
    // 2026-11-16 is a Monday
    const h = [
        { date: "2026-11-14", lessonComplete: true }, // Sat
        { date: "2026-11-15", lessonComplete: false }, // Sun (rest)
        { date: "2026-11-16", lessonComplete: true }, // Mon
        { date: "2026-11-17", lessonComplete: true }, // Tue
        { date: "2026-11-18", lessonComplete: false }, // Wed (rest)
        { date: "2026-11-19", lessonComplete: false }, // Thu (today, not done yet)
    ];
    expect(streak(h, DEFAULT_LESSON_SETTINGS.trainingDays)).toBe(3);
    expect(
        streak(
            [...h.slice(0, 5), { date: "2026-11-19", lessonComplete: true }],
            DEFAULT_LESSON_SETTINGS.trainingDays,
        ),
    ).toBe(4);
    // a missed training day breaks it
    expect(
        streak(
            [
                { date: "2026-11-16", lessonComplete: false },
                { date: "2026-11-17", lessonComplete: true },
                { date: "2026-11-18", lessonComplete: false },
            ],
            [1, 2],
        ),
    ).toBe(1);
});

describe("coach voice", () => {
    const plan = planLesson(base);
    const ctx = {
        hour: 18,
        name: "Devon",
        plan,
        focus: base.focus,
        streak: 3,
        lastGamePattern: "Left a piece loose",
        hasAnyData: true,
        daySeed: 0,
    };
    test("lesson day mentions last game and what's left, not the rule (that's in the card)", () => {
        const m = coachMessage(ctx);
        expect(m.startsWith("Good evening, Devon.")).toBe(true);
        expect(m).toContain("left a piece loose");
        expect(m).toMatch(/\d+ steps.*about \d+ minutes/);
        expect(m).not.toContain("what they can take");
    });
    test("complete, rest and first-time messages", () => {
        const done = planLesson({
            ...base,
            dueDrills: 0,
            today: {
                ...base.today,
                warmupPuzzles: 4,
                focusPuzzles: 6,
                maiaGames: 1,
                marks: ["lookback"],
            },
        });
        expect(coachMessage({ ...ctx, plan: done })).toContain("3 lessons in a row");
        expect(coachMessage({ ...ctx, plan: planLesson({ ...base, weekday: 3 }) })).toContain(
            "Rest day",
        );
        expect(coachMessage({ ...ctx, hasAnyData: false, name: "" })).toMatch(
            /^Good evening\. Welcome/,
        );
    });
    test("step intros", () => {
        expect(stepIntro("play", base.focus)).toContain("Game goal");
        expect(stepIntro("focus", null)).toContain("Mixed tactics");
    });
});
