import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/state/atoms", async (importOriginal) => {
  const { atom } = await import("jotai");
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    enginesAtom: atom([{ type: "local", id: "sf", name: "Stockfish", path: "/sf" }]),
  };
});
const analyse = vi.fn();
vi.mock("@/utils/training", async () => {
  const { atom } = await import("jotai");
  return {
    coachIngestSettingsAtom: atom({ engineId: "sf" }),
    formatEval: (cp: number) => (cp / 100).toFixed(1),
    training: { analyse: (...a: any[]) => analyse(...a) },
  };
});

import { TreeStateContext } from "@/components/common/TreeStateContext";
import CoachPanel from "@/components/panels/coach/CoachPanel";
import { createTreeStore } from "@/state/store/tree";

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
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

async function render(store: ReturnType<typeof createTreeStore>) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <TreeStateContext.Provider value={store}>
          <CoachPanel />
        </TreeStateContext.Provider>
      </MantineProvider>,
    );
  });
  await sleep(20);
}

// Scholar's-mate style game: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
const MOVES = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];

test("why not my move: grades the move just played and shows their reply", async () => {
  const store = createTreeStore();
  store.getState().makeMoves({ payload: MOVES.slice(0, 6) }); // now after 3...Nf6
  // before Nf6 (white just played Bc4, black to move): best g6 at +0.3 for black? use side-to-move cp
  analyse.mockImplementation(async (_p: string, fen: string) => {
    if (fen.includes("r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3")) {
      return [{ cp: -20, mate: null, pvUci: ["g7g6"], pvSan: ["g6", "Qf3", "Nf6"] }];
    }
    // after Nf6: white to move and mates
    return [{ cp: 1000, mate: 1, pvUci: ["h5f7"], pvSan: ["Qxf7#"] }];
  });
  await render(store);
  await sleep(400);
  expect(text()).toContain("Nf6");
  expect(text()).toContain("Mistake");
  expect(text()).toContain("best was g6");
  expect(text()).toContain("Their best reply: Qxf7#");

  // "Show their reply" plays it on the board
  await act(async () => button("Show their reply")!.click());
  expect(store.getState().currentNode().san).toBe("Qxf7#");

  // Step back and play the best move instead
  await act(async () => store.getState().goToMove([0, 0, 0, 0, 0, 0]));
  await sleep(50);
  await act(async () => button("Play best move instead")!.click());
  expect(store.getState().currentNode().san).toBe("g6");
});

test("critical moments: local scan finds the blunder and jumps to it", async () => {
  const store = createTreeStore();
  store.getState().makeMoves({ payload: MOVES });
  store.getState().goToStart();
  analyse.mockImplementation(async (_p: string, fen: string) => {
    // White mates next move after ...Nf6 (white to move): +mate for white
    if (fen.includes("r1bqkb1r/pppp1ppp/2n2n2/4p2Q"))
      return [{ cp: 1000, mate: 1, pvUci: ["h5f7"], pvSan: ["Qxf7#"] }];
    // Position before ...Nf6 (black to move): roughly equal; best g6
    if (fen.includes("r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3"))
      return [{ cp: -20, mate: null, pvUci: ["g7g6"], pvSan: ["g6"] }];
    return [{ cp: 20, mate: null, pvUci: [], pvSan: [] }];
  });
  await render(store);
  // board orientation is white by default -> filter to Black to see Black's blunder
  const blackLabel = [...container.querySelectorAll("label")].find(
    (l) => l.textContent === "Black",
  )!;
  await act(async () => blackLabel.click());
  expect(text()).toContain("hasn't been analysed");
  await act(async () => button("Find critical moments")!.click());
  await sleep(100);
  expect(text()).toContain("3... Nf6");
  expect(text()).toContain("best was g6");
  expect(text()).toContain("blunder");

  // Clicking the moment jumps to the position before the blunder
  const card = [...container.querySelectorAll("p")].find((p) => p.textContent === "3... Nf6")!;
  await act(async () => (card.closest(".mantine-Card-root") as HTMLElement).click());
  expect(store.getState().position).toEqual([0, 0, 0, 0, 0]);
});
