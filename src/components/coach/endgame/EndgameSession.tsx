// Play out an endgame position against perfect defence (Lichess tablebase, or your engine
// when offline), judged move by move against the drill's goal.
import {
  Alert,
  Button,
  Card,
  Group,
  List,
  Loader,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconArrowBackUp, IconBulb, IconCheck, IconRefresh, IconX } from "@tabler/icons-react";
import { makeSan } from "chessops/san";
import { parseUci } from "chessops";
import { getDefaultStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTablebaseInfo } from "@/utils/lichess/api";
import { positionFromFen } from "@/utils/chessops";
import { coachIngestSettingsAtom, type EndgameStat, training } from "@/utils/training";
import { pickEngine } from "../autoAnalyze";
import { MistakeBoard, uciToShape } from "../MistakeBoard";
import { tzOffsetMinutes } from "../lesson/settings";
import { type Drill, goalText } from "./curriculum";
import {
  type Candidate,
  engineVerdict,
  type Fail,
  factsAfter,
  failText,
  flip,
  generateCandidate,
  judgeTheirMove,
  judgeYourMove,
  makeRng,
  needsCheck,
  type OracleResult,
  requiredVerdict,
  tablebaseVerdict,
} from "./endgameLogic";

export type Oracle = (fen: string) => Promise<OracleResult>;

const pieceCount = (fen: string) => fen.split(" ")[0].replace(/[^a-zA-Z]/g, "").length;

/** Tablebase when online (exact), otherwise the coach's engine. */
export const defaultOracle: Oracle = async (fen) => {
  if (pieceCount(fen) <= 7) {
    try {
      const tb = await getTablebaseInfo(fen);
      const verdict = tablebaseVerdict(tb.category);
      if (verdict) return { verdict, best: tb.moves[0]?.uci ?? null, source: "tablebase" };
    } catch {
      // offline or rate-limited: fall through to the engine
    }
  }
  const engine = pickEngine(getDefaultStore().get(coachIngestSettingsAtom).engineId);
  if (!engine)
    throw new Error(
      "Connect to the internet or install an engine (Engines page) for endgame drills.",
    );
  const [line] = await training.analyse(engine.path, fen, 18, 1);
  if (!line) throw new Error("The engine returned no move.");
  return {
    verdict: engineVerdict(line.cp, line.mate),
    best: line.pvUci[0] ?? null,
    source: "engine",
  };
};

type Ply = { fen: string; uci: string | null; san: string | null };
type Phase = "loading" | "you" | "thinking" | "failed" | "success" | "error";

async function pickPosition(
  drill: Drill,
  i: number,
  seed: number,
  oracle: Oracle,
): Promise<Candidate> {
  if ("fens" in drill.source) {
    const fens = drill.source.fens;
    const fen = fens[(seed + i) % fens.length];
    return { fen, orientation: fen.split(" ")[1] === "w" ? "white" : "black" };
  }
  const g = drill.source.generator;
  const rng = makeRng(seed * 31 + i);
  for (let tries = 0; tries < 15; tries++) {
    const c = generateCandidate(g, rng);
    if (!needsCheck(g)) return c;
    const r = await oracle(c.fen);
    if (r.verdict === requiredVerdict(g)) return c;
  }
  throw new Error("Couldn't find a suitable position. Try again.");
}

export default function EndgameSession({
  drill,
  onExit,
  onFinished,
  exitLabel = "Back",
  oracle = defaultOracle,
  seed: seedProp,
  replyDelayMs = 450,
}: {
  drill: Drill;
  onExit: () => void;
  /** Called once every position has been played (before the summary's button). */
  onFinished?: (stats: EndgameStat[]) => void;
  exitLabel?: string;
  oracle?: Oracle;
  seed?: number;
  replyDelayMs?: number;
}) {
  const [seed] = useState(() => seedProp ?? Math.floor(Math.random() * 1e9));
  const [i, setI] = useState(0);
  const [start, setStart] = useState<Candidate | null>(null);
  const [plies, setPlies] = useState<Ply[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [fail, setFail] = useState<Fail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ uci: string; level: 1 | 2 } | null>(null);
  const [dirty, setDirty] = useState(false); // hints, take-backs or restarts used
  const [results, setResults] = useState<{ success: boolean; clean: boolean }[]>([]);
  const [showIdea, setShowIdea] = useState(true);
  const token = useRef(0);

  const yourMoves = plies.filter((p, k) => k > 0 && k % 2 === 1).length;
  const current = plies[plies.length - 1];

  const load = useCallback(async () => {
    const t = ++token.current;
    setPhase("loading");
    setFail(null);
    setHint(null);
    setDirty(false);
    setError(null);
    try {
      const c = await pickPosition(drill, i, seed, oracle);
      if (t !== token.current) return;
      setStart(c);
      setPlies([{ fen: c.fen, uci: null, san: null }]);
      setPhase("you");
    } catch (e) {
      if (t !== token.current) return;
      setError(String(e instanceof Error ? e.message : e));
      setPhase("error");
    }
  }, [drill, i, seed, oracle]);

  useEffect(() => {
    load();
  }, [load]);

  async function record(success: boolean, clean: boolean, moves: number) {
    setResults((r) => [...r, { success, clean }]);
    const stats = await training
      .endgameRecord({ drillId: drill.id, success, clean, moves }, tzOffsetMinutes())
      .catch(() => null);
    if (i + 1 >= drill.positions && stats) onFinished?.(stats);
  }

  function sanOf(fen: string, uci: string): string {
    const [pos] = positionFromFen(fen);
    const m = parseUci(uci);
    return pos && m ? makeSan(pos, m) : uci;
  }

  async function onMove(uci: string) {
    if (phase !== "you" || !current) return;
    const t = token.current;
    const facts = factsAfter(current.fen, uci);
    if (!facts) return;
    const fenAfter = facts.fen;
    const ply: Ply = { fen: fenAfter, uci, san: sanOf(current.fen, uci) };
    const after = [...plies, ply];
    setPlies(after);
    setHint(null);
    setPhase("thinking");
    const movesMade = yourMoves + 1;
    try {
      const terminal = facts.checkmate || facts.stalemate || facts.insufficient;
      const them = terminal ? null : await oracle(fenAfter);
      if (t !== token.current) return;
      const j = judgeYourMove(drill.goal, { ...facts, movesMade }, them?.verdict ?? null);
      if (j.result === "success") {
        setPhase("success");
        record(true, !dirty, movesMade);
        return;
      }
      if (j.result === "fail") {
        setFail(j.why);
        setPhase("failed");
        return;
      }
      const reply = them?.best;
      if (!reply) throw new Error("No reply found.");
      await new Promise((r) => setTimeout(r, replyDelayMs));
      if (t !== token.current) return;
      const f2 = factsAfter(fenAfter, reply);
      if (!f2) throw new Error("Bad reply move.");
      const replyPly: Ply = { fen: f2.fen, uci: reply, san: sanOf(fenAfter, reply) };
      setPlies([...after, replyPly]);
      const j2 = judgeTheirMove(drill.goal, f2);
      if (j2.result === "success") {
        setPhase("success");
        record(true, !dirty, movesMade);
      } else if (j2.result === "fail") {
        setFail(j2.why);
        setPhase("failed");
      } else setPhase("you");
    } catch (e) {
      if (t !== token.current) return;
      setError(String(e instanceof Error ? e.message : e));
      setPhase("error");
    }
  }

  function takeBack() {
    // Back to your last turn before the move that went wrong.
    setDirty(true);
    setFail(null);
    setPlies((p) => {
      let n = p.length - 1;
      // plies at odd indices are yours; drop back to before your last move
      while (n > 0 && n % 2 === 0) n--;
      return p.slice(0, Math.max(1, n));
    });
    setPhase("you");
  }

  function restart() {
    if (!start) return;
    token.current++;
    setDirty(true);
    setFail(null);
    setHint(null);
    setPlies([{ fen: start.fen, uci: null, san: null }]);
    setPhase("you");
  }

  async function giveHint() {
    if (!current) return;
    setDirty(true);
    if (hint) {
      setHint({ ...hint, level: 2 });
      return;
    }
    try {
      const r = await oracle(current.fen);
      if (r.best) setHint({ uci: r.best, level: 1 });
    } catch {}
  }

  function next() {
    if (phase === "failed") record(false, false, yourMoves);
    setI((x) => x + 1);
  }

  if (i >= drill.positions) {
    const solved = results.filter((r) => r.success).length;
    const clean = results.filter((r) => r.success && r.clean).length;
    return (
      <Card withBorder maw={560}>
        <Stack gap="sm">
          <Title order={4}>{drill.title}: done</Title>
          <Text>
            {solved} of {results.length} positions solved
            {clean > 0 ? `, ${clean} without help` : ""}.
          </Text>
          <Text size="sm" c="dimmed">
            A star is earned on each day you solve a position without hints or take-backs. Three
            stars and the coach moves you on.
          </Text>
          <Group>
            <Button onClick={onExit}>{exitLabel}</Button>
            <Button
              variant="subtle"
              onClick={() => {
                setResults([]);
                setI(0);
              }}
            >
              Again
            </Button>
          </Group>
        </Stack>
      </Card>
    );
  }

  if (phase === "error")
    return (
      <Alert color="yellow" title="Couldn't set up the endgame" maw={560}>
        <Text size="sm">{error}</Text>
        <Group mt="sm">
          <Button size="xs" variant="light" onClick={load}>
            Try again
          </Button>
          <Button size="xs" variant="subtle" onClick={onExit}>
            {exitLabel}
          </Button>
        </Group>
      </Alert>
    );

  if (phase === "loading" || !start || !current)
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm">Setting up the position…</Text>
      </Group>
    );

  const you = start.orientation;
  const goal = drill.goal;
  const budget = goal.kind === "hold" ? goal.moves : goal.maxMoves;
  const hintShapes =
    hint?.level === 2 ? [uciToShape(hint.uci, "green")].filter((s) => s !== null) : [];

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <MistakeBoard
        fen={current.fen}
        orientation={you}
        lastMove={current.uci}
        onMove={phase === "you" ? onMove : undefined}
        highlightSquare={hint?.level === 1 ? hint.uci.slice(0, 2) : null}
        shapes={hintShapes}
      />
      <Stack style={{ flex: 1 }} gap="sm" maw={460}>
        <Group justify="space-between">
          <Title order={4}>{drill.title}</Title>
          {drill.positions > 1 && (
            <Text size="sm" c="dimmed">
              Position {i + 1} of {drill.positions}
            </Text>
          )}
        </Group>
        <Text fw={500}>
          You play {you}. {goalText(goal)}.
        </Text>
        <div>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {goal.kind === "hold" ? "Moves held" : "Moves used"}
            </Text>
            <Text size="xs" c="dimmed">
              {yourMoves} / {budget}
            </Text>
          </Group>
          <Progress value={(yourMoves / budget) * 100} size="sm" />
        </div>

        <Card withBorder p="sm" radius="md">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              The idea
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={() => setShowIdea((s) => !s)}>
              {showIdea ? "Hide" : "Show"}
            </Button>
          </Group>
          {showIdea && (
            <List size="sm" spacing={4} mt={4}>
              {drill.idea.map((l) => (
                <List.Item key={l}>{l}</List.Item>
              ))}
            </List>
          )}
        </Card>

        {phase === "thinking" && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Their move…
            </Text>
          </Group>
        )}

        {phase === "you" && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconBulb size="0.9rem" />}
              onClick={giveHint}
            >
              {hint ? "Show the move" : "Hint"}
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              leftSection={<IconRefresh size="0.9rem" />}
              onClick={restart}
            >
              Start over
            </Button>
          </Group>
        )}

        {phase === "failed" && fail && (
          <>
            <Alert color="red" icon={<IconX />} p="xs">
              {failText(fail)}
            </Alert>
            <Group gap="xs">
              {fail !== "tooSlow" && (
                <Button
                  size="xs"
                  leftSection={<IconArrowBackUp size="0.9rem" />}
                  onClick={takeBack}
                >
                  Take back
                </Button>
              )}
              <Button size="xs" variant="light" onClick={restart}>
                Start over
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={next}>
                {i + 1 < drill.positions ? "Next position" : "Finish"}
              </Button>
            </Group>
          </>
        )}

        {phase === "success" && (
          <>
            <Alert color={dirty ? "blue" : "green"} icon={<IconCheck />} p="xs">
              {dirty
                ? `Done in ${yourMoves} moves. Next time, try it without help.`
                : `Done in ${yourMoves} moves, no help needed.`}
            </Alert>
            <Group>
              <Button onClick={() => setI((x) => x + 1)}>
                {i + 1 < drill.positions ? "Next position" : "Finish"}
              </Button>
            </Group>
          </>
        )}

        <Group justify="flex-end">
          <Button size="xs" variant="subtle" color="gray" onClick={onExit}>
            {exitLabel}
          </Button>
        </Group>
      </Stack>
    </Group>
  );
}
