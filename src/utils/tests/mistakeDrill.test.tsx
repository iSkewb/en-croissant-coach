import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// ---- mocks -------------------------------------------------------------------------------
const boardProps: { current: any } = { current: null };
vi.mock("@/components/coach/MistakeBoard", () => ({
  MistakeBoard: (p: any) => {
    boardProps.current = p;
    return null;
  },
  uciToShape: () => null,
}));
vi.mock("@/components/coach/MistakeDetail", () => ({
  MistakeHeader: () => null,
  MistakeExplanation: () => null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("@/utils/tabs", () => ({ createTab: vi.fn() }));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return {
    enginesAtom: atom([{ type: "local", id: "sf", name: "Stockfish", path: "/sf" }]),
    tabsAtom: atom([]),
    activeTabAtom: atom(null),
  };
});

const analyse = vi.fn();
const gradeDrill = vi.fn(async () => new Date());
let queue: any[] = [];
vi.mock("@/utils/training", async () => {
  const { atom } = await import("jotai");
  return {
    coachIngestSettingsAtom: atom({ engineId: "sf" }),
    formatEval: (cp: number) => String(cp),
    tagHint: () => "hint",
    gradeDrill: (...a: any[]) => gradeDrill(...(a as [])),
    training: {
      drillQueue: async () => queue,
      mistakeContext: async () => ({
        prevFen: null,
        prevMoveUci: null,
        prevMoveSan: null,
        gameContinuationUci: [],
        gameContinuationSan: [],
        startFen: null,
        allMovesSan: [],
      }),
      analyse: (...a: any[]) => analyse(...a),
    },
  };
});

import MistakeDrill from "@/components/coach/MistakeDrill";

// ---- helpers -----------------------------------------------------------------------------
const sleep = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeAll(() => {
  window.matchMedia ||= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as any;
  (globalThis as any).ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  analyse.mockReset();
  gradeDrill.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mistake(over: Partial<any>) {
  return {
    id: 1,
    gameId: "g",
    ply: 10,
    playerColor: "white",
    playedUci: "",
    playedSan: "Kf2",
    bestSan: "",
    bestLine: "",
    refutationLine: "",
    evalBeforeCp: 700,
    evalAfterCp: 0,
    winBefore: 90,
    winAfter: 50,
    winDrop: 40,
    severity: "blunder",
    phase: "endgame",
    movedRole: "king",
    clockSecs: null,
    timeSpentSecs: null,
    opponent: "opp",
    opening: null,
    timeControl: null,
    date: null,
    url: null,
    secondUci: null,
    secondCp: null,
    ...over,
  };
}

async function render() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <MistakeDrill />
      </MantineProvider>,
    );
  });
  await sleep(20);
}

async function move(uci: string) {
  expect(boardProps.current.onMove, "board should be interactive").toBeTypeOf("function");
  await act(async () => {
    await boardProps.current.onMove(uci);
  });
  await sleep(500); // opponent reply delay
}

const text = () => container.textContent ?? "";

// ---- tests -------------------------------------------------------------------------------
test("tactic is played out over several moves and graded correct", async () => {
  // Kh8, Qd8 vs Ng5: Nf7+ Kg8 Nxd8 ...
  queue = [
    {
      cardJson: null,
      focus: false,
      mistake: mistake({
        fenBefore: "3q3k/p7/8/6N1/8/8/P7/6K1 w - - 0 40",
        bestUci: "g5f7",
        tags: ["missed_fork", "was_winning"],
      }),
    },
  ];
  analyse.mockImplementation(async (_p: string, fen: string) => {
    if (fen.startsWith("3q3k/p4N2"))
      return [{ cp: -700, mate: null, pvUci: ["h8g8", "f7d8"], pvSan: ["Kg8", "Nxd8"] }];
    if (fen.startsWith("3N2k1/p7"))
      return [{ cp: -900, mate: null, pvUci: ["g8f8", "d8e6"], pvSan: ["Kf8", "Ne6+"] }];
    return [{ cp: -900, mate: null, pvUci: ["f8e7"], pvSan: ["Ke7"] }];
  });
  await render();
  expect(text()).toContain("Find the better move");

  await move("g5f7");
  expect(text()).toContain("Keep going: 2 more moves");
  expect(boardProps.current.fen.startsWith("3q2k1/p4N2")).toBe(true); // opponent replied Kg8

  await move("f7d8");
  expect(text()).toContain("1 more move");
  await move("d8e6");

  expect(text()).toContain("Drill complete");
  expect(text()).toContain("Solved");
  expect(gradeDrill).toHaveBeenCalledWith(expect.anything(), "correct");
});

test("a good-but-not-best move gets credit; a bad move can be retried", async () => {
  // Start position stand-in with a positional mistake: one move needed.
  queue = [
    {
      cardJson: null,
      focus: false,
      mistake: mistake({
        fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        bestUci: "e2e4",
        evalBeforeCp: 40,
        tags: ["positional"],
        secondUci: "d2d4",
        secondCp: 35,
      }),
    },
  ];
  analyse.mockImplementation(async (_p: string, fen: string) => {
    // after f2f3: bad for white (black to move, +300 for black)
    if (fen.includes("5P2")) return [{ cp: 300, mate: null, pvUci: ["e7e5"], pvSan: ["e5"] }];
    // after g1f3: fine
    return [{ cp: -30, mate: null, pvUci: ["d7d5"], pvSan: ["d5"] }];
  });
  await render();

  await move("f2f3");
  expect(text()).toContain("f3 is a mistake");
  expect(text()).toContain("They would answer e5");
  expect(gradeDrill).not.toHaveBeenCalled();

  // Try again, then play a good alternative (not the engine's top move).
  const tryAgain = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Try again"),
  )!;
  await act(async () => tryAgain.click());
  await move("g1f3");
  expect(text()).toContain("Solved, with help"); // retry -> not flawless
  expect(gradeDrill).toHaveBeenCalledWith(expect.anything(), "correct_with_hint");
});

test("second-best move from the game analysis is accepted without waiting for the engine grade", async () => {
  queue = [
    {
      cardJson: null,
      focus: false,
      mistake: mistake({
        fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        bestUci: "e2e4",
        evalBeforeCp: 40,
        tags: ["positional"],
        secondUci: "d2d4",
        secondCp: 35,
      }),
    },
  ];
  analyse.mockResolvedValue([{ cp: 900, mate: null, pvUci: ["d7d5"], pvSan: ["d5"] }]); // would look terrible
  await render();
  await move("d2d4");
  expect(text()).toContain("Solved");
  expect(gradeDrill).toHaveBeenCalledWith(expect.anything(), "correct");
});

test("drill ends early when the line reaches a finished game", async () => {
  queue = [
    {
      cardJson: null,
      focus: false,
      mistake: mistake({
        fenBefore: "3q3k/8/8/6N1/8/8/8/6K1 w - - 0 40",
        bestUci: "g5f7",
        tags: ["missed_fork"],
      }),
    },
  ];
  analyse.mockImplementation(async (_p: string, fen: string) => {
    if (fen.startsWith("3q3k/5N2"))
      return [{ cp: -700, mate: null, pvUci: ["h8g8", "f7d8"], pvSan: ["Kg8", "Nxd8"] }];
    return [{ cp: 0, mate: null, pvUci: ["g8f8"], pvSan: ["Kf8"] }];
  });
  await render();
  await move("g5f7");
  await move("f7d8"); // only K+N vs K left: dead draw, drill finishes
  expect(text()).toContain("Drill complete");
  expect(text()).not.toContain("Keep going");
  expect(gradeDrill).toHaveBeenCalledTimes(1);
});
