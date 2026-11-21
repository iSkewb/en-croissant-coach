import { describe, expect, test } from "vitest";
import { courseProgress, DRILLS, nextDrill } from "@/components/coach/endgame/curriculum";
import {
    engineVerdict,
    factsAfter,
    generateCandidate,
    judgeTheirMove,
    judgeYourMove,
    makeRng,
    tablebaseVerdict,
} from "@/components/coach/endgame/endgameLogic";
import { positionFromFen } from "@/utils/chessops";

const pieces = (fen: string) =>
    fen
        .split(" ")[0]
        .replace(/[^a-zA-Z]/g, "")
        .split("")
        .sort()
        .join("");

describe("generators", () => {
    const expected: Record<string, string> = {
        ladder: "KRRk",
        queen: "KQk",
        rook: "KRk",
        kpkWin: "KPk",
        kpkHold: "KPk",
        catchPawn: "Kkp",
    };
    for (const [g, set] of Object.entries(expected)) {
        test(`${g}: 200 legal positions with the right material`, () => {
            const rng = makeRng(7);
            for (let n = 0; n < 200; n++) {
                const c = generateCandidate(g as any, rng);
                const [pos] = positionFromFen(c.fen);
                expect(pos, c.fen).toBeTruthy();
                expect(pos!.isEnd()).toBe(false);
                expect(pieces(c.fen)).toBe(set.split("").sort().join(""));
                expect(c.orientation).toBe(g === "kpkHold" ? "black" : "white");
                expect(c.fen.split(" ")[1]).toBe(g === "kpkHold" ? "b" : "w");
            }
        });
    }
    test("mates: nothing of yours can be taken and their king isn't in check", () => {
        const rng = makeRng(3);
        for (let n = 0; n < 200; n++) {
            const { fen } = generateCandidate("queen", rng);
            const [pos] = positionFromFen(fen.replace(" w ", " b "));
            // With black to move, the king can't capture the queen.
            const dests = [...pos!.allDests().values()].flatMap((s) => [...s]);
            const queen = [...pos!.board.queen][0];
            expect(dests).not.toContain(queen);
        }
    });
    test("deterministic per seed", () => {
        expect(generateCandidate("rook", makeRng(42)).fen).toBe(
            generateCandidate("rook", makeRng(42)).fen,
        );
    });
});

test("fixed positions are legal", () => {
    for (const d of DRILLS)
        if ("fens" in d.source)
            for (const f of d.source.fens) expect(positionFromFen(f)[0], f).toBeTruthy();
});

test("verdict mapping", () => {
    expect(tablebaseVerdict("win")).toBe("win");
    expect(tablebaseVerdict("cursed-win")).toBe("draw");
    expect(tablebaseVerdict("blessed-loss")).toBe("draw");
    expect(tablebaseVerdict("maybe-loss")).toBe("loss");
    expect(tablebaseVerdict("unknown")).toBeNull();
    expect(engineVerdict(20, 3)).toBe("win");
    expect(engineVerdict(0, -2)).toBe("loss");
    expect(engineVerdict(600, null)).toBe("win");
    expect(engineVerdict(-40, null)).toBe("draw");
});

describe("judging", () => {
    const facts = {
        checkmate: false,
        stalemate: false,
        insufficient: false,
        promoted: false,
        movesMade: 3,
    };
    const mate = { kind: "mate", maxMoves: 10 } as const;
    const hold = { kind: "hold", moves: 5 } as const;
    const promote = { kind: "promote", maxMoves: 10 } as const;
    test("mate goal", () => {
        expect(judgeYourMove(mate, { ...facts, checkmate: true }, null)).toEqual({
            result: "success",
        });
        expect(judgeYourMove(mate, { ...facts, stalemate: true }, null)).toEqual({
            result: "fail",
            why: "stalemate",
        });
        expect(judgeYourMove(mate, facts, "draw")).toEqual({ result: "fail", why: "lostWin" });
        expect(judgeYourMove(mate, facts, "loss")).toEqual({ result: "continue" });
        expect(judgeYourMove(mate, { ...facts, movesMade: 10 }, "loss")).toEqual({
            result: "fail",
            why: "tooSlow",
        });
    });
    test("promote goal", () => {
        expect(judgeYourMove(promote, { ...facts, promoted: true }, "loss")).toEqual({
            result: "success",
        });
        expect(judgeYourMove(promote, { ...facts, promoted: true }, "draw")).toEqual({
            result: "fail",
            why: "lostWin",
        });
    });
    test("hold goal", () => {
        expect(judgeYourMove(hold, facts, "draw")).toEqual({ result: "continue" });
        expect(judgeYourMove(hold, facts, "win")).toEqual({ result: "fail", why: "lostDraw" });
        expect(judgeYourMove(hold, { ...facts, movesMade: 5 }, "draw")).toEqual({
            result: "success",
        });
        expect(judgeYourMove(hold, { ...facts, insufficient: true }, null)).toEqual({
            result: "success",
        });
        expect(
            judgeTheirMove(hold, { checkmate: false, stalemate: false, insufficient: true }),
        ).toEqual({ result: "success" });
        expect(
            judgeTheirMove(hold, { checkmate: true, stalemate: false, insufficient: false }),
        ).toEqual({ result: "fail", why: "mated" });
    });
    test("facts from a real move", () => {
        const f = factsAfter("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8")!;
        expect(f.checkmate).toBe(true);
        const p = factsAfter("8/4P3/8/8/8/2k5/8/4K3 w - - 0 1", "e7e8q")!;
        expect(p.promoted).toBe(true);
        expect(p.fen.startsWith("4Q3/")).toBe(true);
    });
});

describe("course", () => {
    const stat = (
        drillId: string,
        successes: number,
        cleanDays: number,
        lastDate = "2026-11-01",
    ) => ({
        drillId,
        attempts: Math.max(1, successes),
        successes,
        cleanDays,
        lastDate,
    });
    test("starts at the first drill; unlocks in order", () => {
        expect(nextDrill([]).id).toBe("ladder");
        const c = courseProgress([stat("ladder", 1, 1)]);
        expect(c[0].unlocked && c[1].unlocked).toBe(true);
        expect(c[2].unlocked).toBe(false);
        expect(nextDrill([stat("ladder", 1, 1)]).id).toBe("ladder"); // not mastered yet
        expect(nextDrill([stat("ladder", 5, 3)]).id).toBe("queen");
    });
    test("all mastered: review the longest-unpractised", () => {
        const all = DRILLS.map((d, k) =>
            stat(d.id, 3, 3, `2026-11-${String(10 + k).padStart(2, "0")}`),
        );
        all[4].lastDate = "2026-10-01";
        expect(nextDrill(all).id).toBe(DRILLS[4].id);
    });
});
