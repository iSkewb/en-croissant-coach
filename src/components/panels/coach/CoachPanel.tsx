import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Progress,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconBolt, IconPlayerPlay, IconQuestionMark } from "@tabler/icons-react";
import { makeUci } from "chessops";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  GRADE_COLOR,
  GRADE_LABEL,
  gradeMove,
  type MoveGrade,
  sameMove,
} from "@/components/coach/drillLogic";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { enginesAtom } from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import type { LocalEngine } from "@/utils/engines";
import { normalizeScore } from "@/utils/score";
import { coachIngestSettingsAtom, type DrillLine, formatEval, training } from "@/utils/training";
import { treeIteratorMainLine } from "@/utils/treeReducer";
import {
  coverage,
  findCriticalMoments,
  type MainlinePoint,
  moveLabel,
  moverOf,
} from "./criticalMoments";

const SCAN_DEPTH = 12;
const MOVE_DEPTH = 14;

function useCoachEnginePath(): string | null {
  const ingest = useAtomValue(coachIngestSettingsAtom);
  const engines = useAtomValue(enginesAtom);
  return useMemo(() => {
    const local = (engines ?? []).filter((e): e is LocalEngine => e.type === "local");
    return (local.find((e) => e.id === ingest.engineId) ?? local[0])?.path ?? null;
  }, [engines, ingest.engineId]);
}

/** White-POV centipawns for a drill line evaluated at `fen` (side-to-move POV). */
function whiteCpOf(fen: string, line: DrillLine | undefined): number {
  if (!line) {
    const [pos] = positionFromFen(fen);
    if (pos?.isCheckmate()) return pos.turn === "white" ? -1000 : 1000;
    return 0;
  }
  return moverOf(fen) === "white" ? line.cp : -line.cp;
}

// ---------------------------------------------------------------------------------------
// Critical moments
// ---------------------------------------------------------------------------------------

function CriticalMoments({ enginePath }: { enginePath: string | null }) {
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const orientation = useStore(store, (s) => s.headers.orientation ?? "white");
  const goToMove = useStore(store, (s) => s.goToMove);

  const [local, setLocal] = useState<Map<string, { whiteCp: number; bestSan?: string }>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [side, setSide] = useState<"both" | "white" | "black">("both");
  const cancel = useRef(false);

  const line: MainlinePoint[] = useMemo(
    () =>
      [...treeIteratorMainLine(root)].map(({ position, node }) => ({
        position,
        fen: node.fen,
        san: node.san,
        halfMoves: node.halfMoves,
        whiteCp:
          local.get(node.fen)?.whiteCp ??
          (node.score ? normalizeScore(node.score.value, "white") : null),
      })),
    [root, local],
  );

  const covered = coverage(line);
  const moments = useMemo(
    () => findCriticalMoments(line, { color: side === "both" ? null : side, limit: 5 }),
    [line, side],
  );

  // Default the filter to your side once we know which side the board shows.
  useEffect(() => {
    setSide(orientation === "black" ? "black" : "white");
  }, [orientation]);

  async function scan() {
    if (!enginePath) return;
    cancel.current = false;
    setScanning(true);
    setProgress(0);
    const next = new Map(local);
    const todo = line.filter((p) => !next.has(p.fen));
    for (let k = 0; k < todo.length; k++) {
      if (cancel.current) break;
      const p = todo[k];
      try {
        const lines = await training.analyse(enginePath, p.fen, SCAN_DEPTH, 1);
        next.set(p.fen, { whiteCp: whiteCpOf(p.fen, lines[0]), bestSan: lines[0]?.pvSan[0] });
      } catch {
        break;
      }
      setProgress(((k + 1) / todo.length) * 100);
      if (k % 5 === 4) setLocal(new Map(next));
    }
    setLocal(new Map(next));
    setScanning(false);
  }

  const plies = line.length - 1;

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between">
          <Title order={6}>
            <IconBolt size="0.9rem" /> Critical moments
          </Title>
          <SegmentedControl
            size="xs"
            value={side}
            onChange={(v) => setSide(v as typeof side)}
            data={[
              { value: "white", label: "White" },
              { value: "black", label: "Black" },
              { value: "both", label: "Both" },
            ]}
          />
        </Group>

        {plies < 2 && (
          <Text size="sm" c="dimmed">
            Load or play a game to find its turning points.
          </Text>
        )}

        {plies >= 2 && covered < 0.9 && !scanning && (
          <Stack gap={4}>
            <Text size="sm" c="dimmed">
              {covered > 0
                ? "Part of this game has no evaluation yet."
                : "This game hasn't been analysed yet."}{" "}
              A quick local scan ({plies} positions, Stockfish depth {SCAN_DEPTH}) finds the biggest
              swings.
            </Text>
            <Group>
              <Button size="xs" onClick={scan} disabled={!enginePath}>
                Find critical moments
              </Button>
              {!enginePath && (
                <Text size="xs" c="dimmed">
                  Pick an engine in Coach → Settings first.
                </Text>
              )}
            </Group>
          </Stack>
        )}

        {scanning && (
          <Group gap="xs">
            <Progress value={progress} style={{ flex: 1 }} animated />
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={() => (cancel.current = true)}
            >
              Stop
            </Button>
          </Group>
        )}

        {covered >= 0.5 && moments.length === 0 && !scanning && (
          <Text size="sm" c="dimmed">
            No big swings{side !== "both" ? ` for ${side}` : ""}: nothing lost more than 8% win
            chance.
          </Text>
        )}

        {moments.map((m) => {
          const before = line[m.index - 1];
          const best = local.get(before.fen)?.bestSan;
          return (
            <Card
              key={m.index}
              withBorder
              p="xs"
              style={{ cursor: "pointer" }}
              onClick={() => goToMove(m.beforePosition)}
            >
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={0}>
                  <Group gap={6}>
                    <Badge
                      size="sm"
                      color={
                        m.severity === "blunder"
                          ? "red"
                          : m.severity === "mistake"
                            ? "orange"
                            : "yellow"
                      }
                    >
                      {m.severity}
                    </Badge>
                    <Text fw={600} size="sm">
                      {moveLabel(m)}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {m.color === "white" ? "White" : "Black"} lost {Math.round(m.drop)}% win chance
                    ({formatEval(m.beforeCp)} → {formatEval(m.afterCp)})
                    {best && best !== m.san ? ` · best was ${best}` : ""}
                  </Text>
                </Stack>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={(e) => {
                    e.stopPropagation();
                    goToMove(m.afterPosition);
                  }}
                >
                  Show move
                </Button>
              </Group>
            </Card>
          );
        })}
        {moments.length > 0 && (
          <Text size="xs" c="dimmed">
            Click a moment to jump to the position before the move and look for something better.
          </Text>
        )}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// Why not my move?
// ---------------------------------------------------------------------------------------

type MoveVerdict = {
  grade: MoveGrade;
  drop: number;
  moverCp: number;
  bestCp: number;
  bestSan: string | null;
  bestLineSan: string[];
  replySan: string[];
};

const verdictCache = new Map<string, MoveVerdict>();

function WhyNotMyMove({ enginePath }: { enginePath: string | null }) {
  const store = useContext(TreeStateContext)!;
  const cur = useStore(
    store,
    useShallow((s) => {
      const n = s.currentNode();
      const parent = s.position.length > 0 ? s.getNode(s.position.slice(0, -1)) : null;
      return {
        fen: n.fen,
        san: n.san,
        uci: n.move ? makeUci(n.move) : null,
        parentFen: parent?.fen ?? null,
        position: s.position,
      };
    }),
  );
  const goToMove = useStore(store, (s) => s.goToMove);
  const makeMoves = useStore(store, (s) => s.makeMoves);

  const key = cur.parentFen && cur.uci ? `${cur.parentFen}|${cur.uci}` : null;
  const [verdict, setVerdict] = useState<MoveVerdict | null>(
    key ? (verdictCache.get(key) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!key || !enginePath || !cur.parentFen || !cur.uci) {
      setVerdict(null);
      return;
    }
    const cached = verdictCache.get(key);
    if (cached) {
      setVerdict(cached);
      return;
    }
    setVerdict(null);
    let alive = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const before = await training.analyse(enginePath, cur.parentFen!, MOVE_DEPTH, 1);
        const after = await training.analyse(enginePath, cur.fen, MOVE_DEPTH, 1);
        if (!alive) return;
        const best = before[0];
        if (!best) return;
        let moverCp: number;
        if (after[0]) moverCp = -after[0].cp;
        else {
          const [pos] = positionFromFen(cur.fen);
          moverCp = pos?.isCheckmate() ? 1000 : 0;
        }
        const isBest = sameMove(cur.uci, best.pvUci[0]);
        const g = isBest ? { grade: "best" as MoveGrade, drop: 0 } : gradeMove(best.cp, moverCp);
        const v: MoveVerdict = {
          grade: g.grade,
          drop: g.drop,
          moverCp: isBest ? best.cp : moverCp,
          bestCp: best.cp,
          bestSan: best.pvSan[0] ?? null,
          bestLineSan: best.pvSan.slice(0, 6),
          replySan: after[0]?.pvSan.slice(0, 6) ?? [],
        };
        verdictCache.set(key, v);
        setVerdict(v);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, enginePath]);

  function playBest() {
    if (!verdict?.bestSan) return;
    goToMove(cur.position.slice(0, -1));
    makeMoves({ payload: [verdict.bestSan] });
  }

  function playReply() {
    if (!verdict || verdict.replySan.length === 0) return;
    makeMoves({ payload: verdict.replySan.slice(0, 4) });
  }

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Title order={6}>
          <IconQuestionMark size="0.9rem" /> Why not my move?
        </Title>
        {!enginePath && (
          <Text size="sm" c="dimmed">
            Pick an engine in Coach → Settings to check moves.
          </Text>
        )}
        {enginePath && !key && (
          <Text size="sm" c="dimmed">
            Play any move on the board, or step to one, and the coach compares it with the engine's
            best move and shows what it allows.
          </Text>
        )}
        {key && loading && !verdict && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm">Checking {cur.san}…</Text>
          </Group>
        )}
        {error && (
          <Text size="xs" c="red">
            {error}
          </Text>
        )}
        {key && verdict && (
          <>
            <Group gap="xs">
              <Text fw={600}>{cur.san}</Text>
              <Badge color={GRADE_COLOR[verdict.grade]}>{GRADE_LABEL[verdict.grade]}</Badge>
              {verdict.drop >= 1 && (
                <Text size="xs" c="dimmed">
                  −{Math.round(verdict.drop)}% win chance
                </Text>
              )}
            </Group>
            <Text size="sm">
              Eval after your move: <b>{formatEval(verdict.moverCp)}</b> for the side that moved
              {verdict.grade !== "best" && verdict.bestSan && (
                <>
                  {" "}
                  · best was <b>{verdict.bestSan}</b> ({formatEval(verdict.bestCp)})
                </>
              )}
            </Text>
            {verdict.replySan.length > 0 && (
              <Text size="sm">
                Their best reply: <b>{verdict.replySan.slice(0, 4).join(" ")}</b>
              </Text>
            )}
            {verdict.grade !== "best" && verdict.bestLineSan.length > 1 && (
              <Text size="xs" c="dimmed">
                Best line instead: {verdict.bestLineSan.join(" ")}
              </Text>
            )}
            <Group gap="xs">
              {verdict.replySan.length > 0 && (
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconPlayerPlay size="0.8rem" />}
                  onClick={playReply}
                >
                  Show their reply on the board
                </Button>
              )}
              {verdict.grade !== "best" && verdict.bestSan && (
                <Button size="compact-xs" variant="light" color="green" onClick={playBest}>
                  Play best move instead
                </Button>
              )}
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}

export default function CoachPanel() {
  const enginePath = useCoachEnginePath();
  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack p="xs" gap="sm">
        {!enginePath && (
          <Alert color="yellow" p="xs">
            The Coach panel uses your local engine (no Claude usage). Choose one in Coach →
            Settings.
          </Alert>
        )}
        <WhyNotMyMove enginePath={enginePath} />
        <CriticalMoments enginePath={enginePath} />
      </Stack>
    </ScrollArea>
  );
}
