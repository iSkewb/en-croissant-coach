import { describe, expect, test } from "vitest";
import {
    drillOutcome,
    gradeMove,
    isAccepted,
    movesToPlay,
    playUci,
    sameMove,
} from "@/components/coach/drillLogic";

describe("gradeMove", () => {
    test("near-equal moves are excellent", () => {
        expect(gradeMove(150, 130).grade).toBe("excellent");
    });
    test("slightly worse but fine is good", () => {
        expect(gradeMove(150, 60).grade).toBe("good");
    });
    test("throwing away a winning position is wrong", () => {
        expect(gradeMove(500, 0).grade).toBe("wrong");
    });
    test("in a totally winning position small slips still count", () => {
        expect(isAccepted(gradeMove(1000, 700).grade)).toBe(true);
    });
    test("a better-than-expected move never has a negative drop", () => {
        expect(gradeMove(100, 300).drop).toBe(0);
    });
});

describe("movesToPlay", () => {
    test("positional mistakes are one move", () => {
        expect(movesToPlay(["positional", "was_winning"])).toBe(1);
    });
    test("tactics are played out", () => {
        expect(movesToPlay(["missed_fork"])).toBe(3);
        expect(movesToPlay(["missed_mate"])).toBe(4);
    });
});

describe("drillOutcome", () => {
    test("flawless first try is correct", () => {
        expect(
            drillOutcome({
                grades: ["best", "excellent"],
                hints: 0,
                failedAttempts: 0,
                revealed: false,
            }),
        ).toBe("correct");
    });
    test("a merely good move or a retry is a hard pass", () => {
        expect(
            drillOutcome({ grades: ["good"], hints: 0, failedAttempts: 0, revealed: false }),
        ).toBe("correct_with_hint");
        expect(
            drillOutcome({ grades: ["best"], hints: 0, failedAttempts: 1, revealed: false }),
        ).toBe("correct_with_hint");
    });
    test("revealing the answer is a miss", () => {
        expect(
            drillOutcome({ grades: ["best"], hints: 0, failedAttempts: 0, revealed: true }),
        ).toBe("wrong");
    });
});

describe("playUci", () => {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    test("plays legal moves with SAN", () => {
        const r = playUci(start, "g1f3");
        expect(r?.san).toBe("Nf3");
        expect(r?.fen.startsWith("rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b")).toBe(true);
    });
    test("rejects illegal moves", () => {
        expect(playUci(start, "e2e5")).toBeNull();
    });
    test("detects mate", () => {
        const r = playUci("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8");
        expect(r?.mate).toBe(true);
    });
    test("sameMove ignores missing promotion piece", () => {
        expect(sameMove("e7e8q", "e7e8")).toBe(true);
        expect(sameMove("e2e4", "e2e3")).toBe(false);
    });
});
