// The endgame course: what to learn, in what order, and when it's mastered.
import type { EndgameStat } from "@/utils/training";

export type Goal =
    | { kind: "mate"; maxMoves: number }
    | { kind: "promote"; maxMoves: number }
    /** Keep the draw for `moves` of your moves (or win the pawn / reach a dead draw sooner). */
    | { kind: "hold"; moves: number };

export type Generator = "ladder" | "queen" | "rook" | "catchPawn" | "kpkWin" | "kpkHold";

export type Drill = {
    id: string;
    title: string;
    /** One line for lists. */
    summary: string;
    /** The idea, in a few short steps. Shown before and during the drill. */
    idea: string[];
    goal: Goal;
    /** Random positions from a generator, or fixed positions (you are the side to move). */
    source: { generator: Generator } | { fens: string[] };
    positions: number;
};

export const DRILLS: Drill[] = [
    {
        id: "ladder",
        title: "Two-rook checkmate",
        summary: "Walk the king to the edge with the rook ladder",
        idea: [
            "One rook cuts the king off along a rank or file, the other gives check on the next line.",
            "Swap roles each move so the king is pushed back one line at a time.",
            "If the king attacks a rook, move that rook far away along the same line.",
        ],
        goal: { kind: "mate", maxMoves: 10 },
        source: { generator: "ladder" },
        positions: 2,
    },
    {
        id: "queen",
        title: "Queen checkmate",
        summary: "King and queen against a lone king",
        idea: [
            "Put your queen a knight's jump from their king to fence it in, and keep that shape as it moves.",
            "Shrink the box until the king is on the edge, then stop and bring your own king over.",
            "Watch for stalemate: after every queen move, make sure their king still has a square.",
            "Mate on the edge with your king supporting the queen.",
        ],
        goal: { kind: "mate", maxMoves: 15 },
        source: { generator: "queen" },
        positions: 2,
    },
    {
        id: "rook",
        title: "Rook checkmate",
        summary: "King and rook against a lone king",
        idea: [
            "Use the rook to cut the king off along a rank or file.",
            "Bring your king up so the two kings face each other (opposition), then check with the rook.",
            "When their king steps away, make a waiting move with the rook along its line.",
            "Each check in opposition pushes them back one line, until mate on the edge.",
        ],
        goal: { kind: "mate", maxMoves: 30 },
        source: { generator: "rook" },
        positions: 2,
    },
    {
        id: "catchPawn",
        title: "Catch the pawn",
        summary: "Use the square of the pawn to stop a runner",
        idea: [
            "Draw a square from the pawn to its promotion rank. If your king can step into it, you catch the pawn.",
            "Head straight for the pawn's path; diagonal king moves cover two directions at once.",
            "Once you're in front of the pawn, take it when it comes to you.",
        ],
        goal: { kind: "hold", moves: 12 },
        source: { generator: "catchPawn" },
        positions: 2,
    },
    {
        id: "kpkWin",
        title: "King and pawn: winning",
        summary: "Opposition and key squares",
        idea: [
            "Your king walks in front of the pawn, not behind it.",
            "Aim for the key squares two ranks in front of your pawn; once your king is there, the pawn queens.",
            "Kings facing each other with one square between: the side NOT to move has the opposition.",
            "Push the pawn only when your king is already in front of it.",
        ],
        goal: { kind: "promote", maxMoves: 20 },
        source: { generator: "kpkWin" },
        positions: 2,
    },
    {
        id: "kpkHold",
        title: "King and pawn: defending",
        summary: "Stay in front and keep the opposition",
        idea: [
            "Keep your king directly in front of the pawn.",
            "When their king comes forward, step in front of it (take the opposition).",
            "When the pawn reaches your second rank, stay on the promotion square or right beside it; stalemate saves you.",
        ],
        goal: { kind: "hold", moves: 15 },
        source: { generator: "kpkHold" },
        positions: 2,
    },
    {
        id: "lucena",
        title: "Lucena: building a bridge",
        summary: "The winning method in rook and pawn endings",
        idea: [
            "Your pawn is on the 7th and your king is stuck in front of it.",
            "First push their king away from the pawn with a rook check from the side.",
            "Bring your rook to the 4th rank. That's the bridge.",
            "Walk your king out; when the checks come, block them with your rook on the 4th.",
        ],
        goal: { kind: "promote", maxMoves: 15 },
        source: {
            fens: ["1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1", "2K1k3/2P5/8/8/8/8/1r6/3R4 w - - 0 1"],
        },
        positions: 1,
    },
    {
        id: "philidor",
        title: "Philidor: the safe defence",
        summary: "How to draw rook and pawn against rook",
        idea: [
            "Keep your king on the promotion square or next to it.",
            "Keep your rook on your 6th rank so their king can't come forward.",
            "When the pawn steps onto your 6th rank, swing your rook behind and check from far away.",
        ],
        goal: { kind: "hold", moves: 15 },
        source: {
            fens: ["4k3/7R/r7/3KP3/8/8/8/8 b - - 0 1", "3k4/6R1/1r6/2KP4/8/8/8/8 b - - 0 1"],
        },
        positions: 1,
    },
];

export const drillById = (id: string) => DRILLS.find((d) => d.id === id) ?? null;

export function goalText(goal: Goal): string {
    switch (goal.kind) {
        case "mate":
            return `Checkmate in ${goal.maxMoves} moves or fewer`;
        case "promote":
            return `Promote the pawn safely within ${goal.maxMoves} moves`;
        case "hold":
            return `Hold the draw for ${goal.moves} moves`;
    }
}

export type DrillProgress = {
    drill: Drill;
    unlocked: boolean;
    /** 0–3: days with a clean success. */
    stars: number;
    attempts: number;
    lastDate: string | null;
};

export function courseProgress(stats: EndgameStat[]): DrillProgress[] {
    const byId = new Map(stats.map((s) => [s.drillId, s]));
    return DRILLS.map((drill, i) => {
        const s = byId.get(drill.id);
        const prev = i > 0 ? byId.get(DRILLS[i - 1].id) : null;
        return {
            drill,
            unlocked: i === 0 || (prev?.successes ?? 0) > 0 || (s?.attempts ?? 0) > 0,
            stars: Math.min(3, s?.cleanDays ?? 0),
            attempts: s?.attempts ?? 0,
            lastDate: s?.lastDate ?? null,
        };
    });
}

/** The drill a lesson should use: the first unfinished one, else the longest-unpractised. */
export function nextDrill(stats: EndgameStat[]): Drill {
    const course = courseProgress(stats);
    const learning = course.find((c) => c.unlocked && c.stars < 3);
    if (learning) return learning.drill;
    const oldest = [...course].sort((a, b) =>
        (a.lastDate ?? "").localeCompare(b.lastDate ?? ""),
    )[0];
    return oldest.drill;
}
