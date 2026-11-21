// The coach's words: short, warm, specific. Templates filled with real numbers, so the
// daily lesson costs nothing from your Claude plan. Unit-tested.
import { type LessonPlan, type StepId, WEEKDAY_NAMES } from "./lessonPlan";

export type VoiceContext = {
    hour: number;
    name: string;
    plan: LessonPlan;
    focus: { title: string; rule: string } | null;
    streak: number;
    /** Plain label of the costliest pattern in your most recent analysed game, if any. */
    lastGamePattern: string | null;
    hasAnyData: boolean;
    /** Stable per-day number to vary phrasing without randomness. */
    daySeed: number;
};

function greeting(hour: number, name: string): string {
    const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    return name.trim() ? `${part}, ${name.trim()}.` : `${part}.`;
}

const pick = <T>(arr: T[], seed: number) => arr[Math.abs(seed) % arr.length];

export function coachMessage(ctx: VoiceContext): string {
    const hello = greeting(ctx.hour, ctx.name);
    const { plan } = ctx;

    if (!ctx.hasAnyData) {
        return `${hello} Welcome to your first lesson. Play a game against Maia or bring in your online games, and I'll find what to work on.`;
    }
    if (plan.kind === "rest") {
        const next =
            plan.nextTrainingDay !== null
                ? ` Next lesson: ${WEEKDAY_NAMES[plan.nextTrainingDay]}.`
                : "";
        const optional =
            plan.steps.length > 0 ? " If you have five minutes, a few reviews are waiting." : "";
        return `${hello} Rest day. What you practised settles in when you step away.${optional}${next}`;
    }
    if (plan.complete) {
        const streakLine = ctx.streak > 1 ? ` That's ${ctx.streak} lessons in a row.` : "";
        const next =
            plan.nextTrainingDay !== null ? ` See you ${WEEKDAY_NAMES[plan.nextTrainingDay]}.` : "";
        return `${hello} That's today's lesson done.${streakLine}${next}`;
    }

    const parts = [hello];
    if (ctx.lastGamePattern) {
        parts.push(
            pick(
                [
                    `In your last game, the costliest moment was: ${ctx.lastGamePattern.toLowerCase()}.`,
                    `Last time, the move that hurt most was a case of "${ctx.lastGamePattern.toLowerCase()}".`,
                ],
                ctx.daySeed,
            ),
        );
    }
    if (ctx.focus) {
        parts.push(
            pick(
                [
                    `This week we're working on ${ctx.focus.title.toLowerCase()}. Today's rule: ${ctx.focus.rule}`,
                    `Our focus is ${ctx.focus.title.toLowerCase()}. Keep one habit in mind: ${ctx.focus.rule}`,
                ],
                ctx.daySeed + 1,
            ),
        );
    } else {
        parts.push("Let's build the habit of checking what's attacked before every move.");
    }
    if (plan.checkinDay) parts.push("We'll finish with the weekly check-in.");
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** One line the coach says when you start a step. */
export function stepIntro(id: StepId, focus: { title: string; rule: string } | null): string {
    switch (id) {
        case "online":
            return "First, let's see what happened in your online games.";
        case "warmup":
            return "Easy ones first. Get your eyes moving.";
        case "review":
            return "These are positions from your own games. Find what you missed.";
        case "focus":
            return focus
                ? `Today's theme: ${focus.title.toLowerCase()}. Take your time on each one.`
                : "Mixed tactics. Look for checks, captures and threats.";
        case "play":
            return focus
                ? `Game goal: ${focus.rule} Pause whenever you need to think.`
                : "Play your normal game. Pause whenever you need to think.";
        case "lookback":
            return "Let's look at the moment that mattered most. Find the better move first.";
        case "checkin":
            return "End of the week. Let's see what changed.";
    }
}
