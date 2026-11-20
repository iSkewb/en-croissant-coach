import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const boardProps: { current: any } = { current: null };
vi.mock("@/components/coach/MistakeBoard", () => ({
  MistakeBoard: (p: any) => {
    boardProps.current = p;
    return null;
  },
  uciToShape: () => null,
}));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return { selectedPuzzleDbAtom: atom("/p/puzzles.duckdb") };
});
vi.mock("@/utils/puzzles", () => ({
  getPuzzleDatabases: async () => [{ path: "/p/puzzles.duckdb" }],
}));

const recordPuzzle = vi.fn();
const themedPuzzles = vi.fn();
let rating = 1500;
vi.mock("@/utils/training", () => ({
  training: {
    themedPuzzles: (...a: any[]) => themedPuzzles(...a),
    recordPuzzle: async (a: any) => {
      recordPuzzle(a);
      rating += a.solved ? 12 : -12;
      return { rating, attempts: 1, solved: a.solved ? 1 : 0, themeStats: [] };
    },
    puzzleProfile: async () => ({ rating, attempts: 0, solved: 0, themeStats: [] }),
  },
}));

import CoachPuzzles from "@/components/coach/CoachPuzzles";

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
  rating = 1500;
  recordPuzzle.mockClear();
  themedPuzzles.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// setup 1.e4 (opponent), you ...e5, they Nf3, you ...Nc6
const PUZZLE = {
  id: 42,
  fen: START,
  moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
  rating: 1480,
  themes: ["fork", "opening"],
};
const insight = {
  id: 1,
  createdAt: "",
  mistakesAnalyzed: 10,
  summary: "",
  strengths: [],
  plan: [],
  progressNote: "",
  weaknesses: [
    {
      title: "Loose pieces",
      evidence: "",
      ruleOfThumb: "",
      mistakeIds: [],
      drillTags: [],
      puzzleThemes: ["fork", "hangingPiece"],
      priority: 1,
    },
  ],
};

async function render() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <CoachPuzzles insight={insight as any} initialTarget={null} onTargetUsed={() => {}} />
      </MantineProvider>,
    );
  });
  await sleep(30);
}
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
async function click(label: string) {
  await act(async () => button(label).click());
  await sleep(30);
}
async function move(uci: string) {
  expect(boardProps.current.onMove, "board should be interactive").toBeTypeOf("function");
  await act(async () => boardProps.current.onMove(uci));
  await sleep(450);
}

test("weakness → practice → solve multi-move puzzle → summary", async () => {
  themedPuzzles.mockResolvedValue([PUZZLE]);
  await render();
  expect(text()).toContain("Loose pieces");
  await click("Practice 10");
  // rating window ±150 around 1500, both themes requested
  expect(themedPuzzles).toHaveBeenCalledWith(
    "/p/puzzles.duckdb",
    ["fork", "hangingPiece"],
    1350,
    1650,
    10,
  );
  await sleep(800); // opponent setup move
  expect(text()).toContain("Find the best move for black");
  expect(boardProps.current.orientation).toBe("black");

  await move("e7e5");
  expect(boardProps.current.fen).toContain("5N2"); // they replied Nf3
  await move("b8c6");
  expect(text()).toContain("Solved!");
  expect(recordPuzzle).toHaveBeenCalledWith(
    expect.objectContaining({ puzzleId: 42, solved: true, weakness: "Loose pieces", hints: 0 }),
  );

  await click("Finish");
  expect(text()).toContain("Session complete");
  expect(text()).toContain("Solved 1 of 1");
  expect(text()).toContain("1512");
});

test("wrong move then retry counts as a miss; show solution plays the line", async () => {
  themedPuzzles.mockResolvedValue([PUZZLE, { ...PUZZLE, id: 43 }]);
  await render();
  await click("Practice 10");
  await sleep(800);

  await move("d7d5");
  expect(text()).toContain("isn't it");
  await click("Try again");
  await move("e7e5");
  await move("b8c6");
  expect(text()).toContain("Counts as a miss");
  expect(recordPuzzle).toHaveBeenLastCalledWith(
    expect.objectContaining({ puzzleId: 42, solved: false }),
  );

  await click("Next puzzle");
  await sleep(800);
  await click("Show solution");
  expect(text()).toContain("Solution");
  expect(recordPuzzle).toHaveBeenLastCalledWith(
    expect.objectContaining({ puzzleId: 43, solved: false }),
  );
  expect(recordPuzzle).toHaveBeenCalledTimes(2);
});
