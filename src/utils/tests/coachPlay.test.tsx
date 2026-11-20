import { MantineProvider } from "@mantine/core";
import { getDefaultStore } from "jotai";
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createTab: vi.fn(),
}));
vi.mock("@/bindings", () => ({
  commands: { getOpeningFromFens: async () => ({ status: "ok", data: "Italian Game" }) },
  events: { progressEvent: { listen: async () => () => {} } },
}));
const analyzePgnFile = vi.fn(async () => ({ mistakesFound: 2 }));
vi.mock("@/components/coach/autoAnalyze", () => ({
  analyzePgnFile: (...a: any[]) => analyzePgnFile(...(a as [])),
  pickEngine: () => ({ path: "/sf" }),
}));

// Maia replies, keyed by how many moves have been played.
let script: Record<number, string> = {};
let installed = true;
const maiaMove = vi.fn(async (_f: string, moves: string[]) => script[moves.length] ?? null);
const maiaRecordGame = vi.fn(async (_g: any) => "/data/coach/maia-games.pgn");
const maiaInstall = vi.fn(async () => {
  installed = true;
  return { installed: true, folder: "/x", model: "5m" };
});
vi.mock("@/utils/training", async () => {
  const { atom } = await import("jotai");
  return {
    coachIngestSettingsAtom: atom({ engineId: "sf" }),
    MAIA_INSTALL_PROGRESS_ID: "maia_install",
    training: {
      maiaStatus: async () => ({ installed, folder: "/x", model: "5m" }),
      maiaSummary: async () => ({
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        suggestedElo: 1100,
        byLevel: [],
        openings: [],
        recent: [],
      }),
      maiaInstall: () => maiaInstall(),
      maiaUninstall: async () => ({ installed: false, folder: "/x", model: "5m" }),
      maiaMove: (...a: any[]) => maiaMove(...(a as [string, string[]])),
      maiaRecordGame: (g: any) => maiaRecordGame(g),
      analyse: async () => [{ cp: 30, mate: null, pvUci: ["g1f3"], pvSan: ["Nf3"] }],
    },
  };
});

import CoachPlay, { playSetupAtom } from "@/components/coach/CoachPlay";

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
  vi.spyOn(Math, "random").mockReturnValue(0); // shortest "human" delay
});
beforeEach(() => {
  installed = true;
  script = {};
  maiaMove.mockClear();
  maiaRecordGame.mockClear();
  analyzePgnFile.mockClear();
  getDefaultStore().set(playSetupAtom, {
    elo: null,
    color: "white",
    tc: "none",
    hints: true,
    takebacks: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label));
async function click(label: string) {
  const b = button(label);
  expect(b, `button "${label}"`).toBeTruthy();
  await act(async () => b!.click());
  await sleep(20);
}
async function render() {
  await act(async () => {
    root.render(
      <MantineProvider>
        <CoachPlay />
      </MantineProvider>,
    );
  });
  await sleep(30);
}
async function move(uci: string) {
  expect(boardProps.current.onMove, "board should be interactive").toBeTypeOf("function");
  await act(async () => boardProps.current.onMove(uci));
  await sleep(700); // Maia's (minimum) human-like delay
}

test("win with a mate: game saved with opening + PGN, then analysed as 'You'", async () => {
  script = { 1: "e7e5", 3: "b8c6", 5: "g8f6" };
  await render();
  expect(text()).toContain("≈ Chess.com rapid 750");
  await click("Play");
  expect(text()).toContain("Your move");
  await move("e2e4");
  expect(maiaMove).toHaveBeenLastCalledWith(expect.any(String), ["e2e4"], 1100);
  await move("f1c4");
  await move("d1h5");
  expect(text()).toContain("Your move");
  await act(async () => boardProps.current.onMove("h5f7"));
  await sleep(100);
  expect(text()).toContain("You won!");
  expect(text()).toContain("checkmate");
  const rec = maiaRecordGame.mock.calls[0][0];
  expect(rec).toMatchObject({
    color: "white",
    elo: 1100,
    result: "win",
    plies: 7,
    opening: "Italian Game",
  });
  expect(rec.pgn).toContain('[White "You"]');
  expect(rec.pgn).toContain('[BlackElo "1100"]');
  expect(rec.pgn).toContain("4. Qxf7# 1-0");
  expect(analyzePgnFile).toHaveBeenCalledWith("/data/coach/maia-games.pgn", "You");
  expect(text()).toContain("Analysed: 2 mistakes added to your drills.");
});

test("pause holds Maia's move; takeback undoes your move and Maia's reply", async () => {
  script = { 1: "e7e5", 3: "d7d6" };
  await render();
  await click("Play");
  await act(async () => boardProps.current.onMove("e2e4"));
  await click("Pause");
  await sleep(900);
  expect(text()).toContain("Paused");
  expect(boardProps.current.fen.split(" ")[1]).toBe("b"); // Maia hasn't moved
  await click("Resume");
  await sleep(800);
  expect(boardProps.current.fen.split(" ")[1]).toBe("w");
  expect(text()).toContain("Your move");

  await move("g1f3");
  expect(boardProps.current.fen).toContain("3p4"); // ...d6 played
  await click("Takeback");
  // back to after 1.e4 e5, white to move
  expect(
    boardProps.current.fen.startsWith("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w"),
  ).toBe(true);
  expect(text()).toContain("takebacks: 1");
});

test("first-time setup, then resign records a loss", async () => {
  installed = false;
  script = { 1: "e7e5" };
  await render();
  expect(text()).toContain("Set up Maia-3");
  await click("Set up Maia-3");
  expect(maiaInstall).toHaveBeenCalled();
  expect(text()).toContain("Play a human-like opponent");
  await click("Play");
  await move("e2e4");
  await click("Resign");
  await sleep(50);
  expect(text()).toContain("Maia won");
  expect(maiaRecordGame.mock.calls[0][0]).toMatchObject({ result: "loss", plies: 2 });
});
