import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return { selectedPuzzleDbAtom: atom("/p/puzzles.duckdb"), sessionsAtom: atom([]) };
});
vi.mock("@/utils/puzzles", () => ({
  getPuzzleDatabases: async () => [{ path: "/p/puzzles.duckdb" }],
}));
vi.mock("@/components/coach/autoAnalyze", () => ({ connectedAccounts: () => [] }));
vi.mock("@/components/coach/CoachPuzzles", () => ({
  PuzzleSession: (p: any) => (
    <div data-testid="puzzle-session">{`${p.target.title}:${p.count}:${p.ratingOffset}`}</div>
  ),
}));
vi.mock("@/components/coach/MistakeDrill", () => ({
  default: (p: any) => <div data-testid="drill">{`limit:${p.limit}`}</div>,
}));
vi.mock("@/components/coach/CoachPlay", async () => {
  const { atom } = await import("jotai");
  return {
    playSetupAtom: atom({ elo: null, color: "white", tc: "none", hints: true, takebacks: true }),
    PlayGame: () => <div data-testid="play-game" />,
    InstallCard: () => <div data-testid="install-card" />,
  };
});
vi.mock("@/components/coach/lesson/steps", () => ({
  OnlineStep: () => null,
  LookBackStep: () => <div data-testid="lookback" />,
  CheckinStep: () => <div data-testid="checkin" />,
}));

const setMark = vi.fn(async () => {});
let today: any;
vi.mock("@/utils/training", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    training: {
      today: async () => today,
      history: async () => [],
      stats: async () => ({ games: 12, mistakes: 40, cardsDue: 8, monthlyRate: [] }),
      latestInsight: async () => ({
        weaknesses: [
          {
            title: "Hanging pieces",
            ruleOfThumb: "Before you move, ask what it leaves undefended.",
            puzzleThemes: ["hangingPiece"],
            priority: 1,
            evidence: "",
            mistakeIds: [],
            drillTags: [],
          },
        ],
      }),
      maiaStatus: async () => ({ installed: true, folder: "", model: "" }),
      maiaSummary: async () => ({ games: 3, suggestedElo: 1100 }),
      puzzleProfile: async () => ({ rating: 1200, attempts: 0, solved: 0, themeStats: [] }),
      mistakes: async () => [],
      setMark: (...a: any[]) => setMark(...(a as [])),
    },
  };
});

import TodayLesson from "@/components/coach/lesson/TodayLesson";

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
  localStorage.clear();
  setMark.mockClear();
  today = {
    date: "2026-11-17", // a Tuesday: a default training day
    drillsReviewed: 0,
    warmupPuzzles: 0,
    focusPuzzles: 0,
    maiaGames: 0,
    gamesAnalyzed: 0,
    marks: [],
    insightToday: false,
    latestInsightDate: "2026-11-15",
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <TodayLesson />
      </MantineProvider>,
    );
  });
  await sleep(20);
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement;

test("shows the ordered lesson with the week's focus and one primary button", async () => {
  await render();
  const steps = [...container.querySelectorAll('[data-testid^="step-"]')].map((e) =>
    e.getAttribute("data-testid"),
  );
  expect(steps).toEqual(["step-warmup", "step-review", "step-focus", "step-play", "step-lookback"]);
  expect(container.textContent).toContain("This week's focus");
  expect(container.textContent).toContain("Hanging pieces");
  expect(q("coach-message")?.textContent).toContain("hanging pieces");
  expect(button("Start: Warm-up")).toBeTruthy();
});

test("starting a step opens it with the coach's intro, and back returns", async () => {
  await render();
  await act(async () => button("Start: Warm-up").click());
  expect(q("puzzle-session")?.textContent).toBe("Warm-up:4:-300");
  expect(container.textContent).toContain("Easy ones first");
  await act(async () => button("Lesson").click());
  await sleep(10);
  expect(q("step-warmup")).toBeTruthy();
});

test("focus puzzles use the week's themes and only what's left", async () => {
  today.warmupPuzzles = 4;
  today.drillsReviewed = 6;
  today.focusPuzzles = 2;
  await render();
  expect(button("Continue: Focus training")).toBeTruthy();
  await act(async () => button("Continue: Focus training").click());
  expect(q("puzzle-session")?.textContent).toBe("Hanging pieces:4:0");
});

test("skipping a step records a mark", async () => {
  await render();
  const skip = container.querySelector('[aria-label="Skip Warm-up"]') as HTMLButtonElement;
  await act(async () => skip.click());
  expect(setMark).toHaveBeenCalledWith("2026-11-17", "skip:warmup", true);
});

test("a finished lesson is recorded once", async () => {
  Object.assign(today, {
    warmupPuzzles: 4,
    drillsReviewed: 6,
    focusPuzzles: 6,
    maiaGames: 1,
    marks: ["lookback"],
  });
  await render();
  expect(setMark).toHaveBeenCalledWith("2026-11-17", "lesson_complete", true);
  expect(container.textContent).toContain("today's lesson done");
});

test("rest days offer only due reviews and a train-anyway button", async () => {
  today.date = "2026-11-18"; // Wednesday: rest by default
  await render();
  const steps = [...container.querySelectorAll('[data-testid^="step-"]')].map((e) =>
    e.getAttribute("data-testid"),
  );
  expect(steps).toEqual(["step-review"]);
  expect(container.textContent).toContain("Rest day");
  await act(async () => button("Train anyway").click());
  expect(setMark).toHaveBeenCalledWith("2026-11-18", "train_anyway", true);
});
