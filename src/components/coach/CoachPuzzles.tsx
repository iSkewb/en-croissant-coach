import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  MultiSelect,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowBackUp,
  IconBulb,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconPuzzle,
  IconTarget,
  IconX,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { selectedPuzzleDbAtom } from "@/state/atoms";
import { getPuzzleDatabases } from "@/utils/puzzles";
import { type CoachPuzzle, type Insight, type PuzzleProfile, training } from "@/utils/training";
import { playUci } from "./drillLogic";
import { MistakeBoard } from "./MistakeBoard";
import { checkPuzzleMove, pct, ratingWindow, themeLabel, themeSummary } from "./puzzleLogic";

/** Themes offered in the manual picker (all Lichess puzzle themes the coach can recommend). */
const PICKABLE_THEMES = [
  "fork",
  "pin",
  "skewer",
  "hangingPiece",
  "trappedPiece",
  "discoveredAttack",
  "doubleCheck",
  "deflection",
  "attraction",
  "clearance",
  "interference",
  "xRayAttack",
  "intermezzo",
  "quietMove",
  "defensiveMove",
  "zugzwang",
  "capturingDefender",
  "mateIn1",
  "mateIn2",
  "mateIn3",
  "backRankMate",
  "smotheredMate",
  "kingsideAttack",
  "queensideAttack",
  "exposedKing",
  "sacrifice",
  "advancedPawn",
  "promotion",
  "endgame",
  "rookEndgame",
  "pawnEndgame",
  "bishopEndgame",
  "knightEndgame",
  "queenEndgame",
];

export type PracticeTarget = { title: string; themes: string[] };

type Node = {
  fen: string;
  uci?: string;
  san?: string;
  by: "start" | "opp" | "you";
  wrong?: boolean;
};
type Phase = "loading" | "intro" | "solving" | "wrong" | "done";
type Result = { puzzle: CoachPuzzle; solved: boolean };

const SESSION_SIZE = 10;

function PuzzleSession({
  db,
  target,
  profile,
  onProfile,
  onExit,
}: {
  db: string;
  target: PracticeTarget;
  profile: PuzzleProfile;
  onProfile: (p: PuzzleProfile) => void;
  onExit: () => void;
}) {
  const [puzzles, setPuzzles] = useState<CoachPuzzle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [view, setView] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [moveIdx, setMoveIdx] = useState(1);
  const [failed, setFailed] = useState(false);
  const [hints, setHints] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [startRating] = useState(profile.rating);
  const startedAt = useRef(Date.now());
  const token = useRef(0);
  const recorded = useRef(false);

  const load = useCallback(async () => {
    setPuzzles(null);
    setError(null);
    const [lo, hi] = ratingWindow(profile.rating);
    try {
      let ps = await training.themedPuzzles(db, target.themes, lo, hi, SESSION_SIZE);
      if (ps.length < SESSION_SIZE) {
        // Widen the window if the themes are rare around this rating.
        const [lo2, hi2] = ratingWindow(profile.rating, 400);
        const more = await training.themedPuzzles(db, target.themes, lo2, hi2, SESSION_SIZE);
        const seen = new Set(ps.map((p) => p.id));
        ps = [...ps, ...more.filter((p) => !seen.has(p.id))].slice(0, SESSION_SIZE);
      }
      if (ps.length === 0) setError("No new puzzles found for these themes. Try other themes.");
      setPuzzles(ps);
      setI(0);
      setResults([]);
    } catch (e) {
      setError(String(e));
    }
  }, [db, target.themes.join(",")]);

  useEffect(() => {
    load();
  }, [load]);

  const puzzle = puzzles?.[i];

  // Start a puzzle: show the position, then play the opponent's setup move.
  useEffect(() => {
    if (!puzzle) return;
    const t = ++token.current;
    recorded.current = false;
    setFailed(false);
    setHints(0);
    setRevealed(false);
    setMoveIdx(1);
    setNodes([{ fen: puzzle.fen, by: "start" }]);
    setView(0);
    setPhase("intro");
    const setup = playUci(puzzle.fen, puzzle.moves[0]);
    setTimeout(() => {
      if (t !== token.current || !setup) return;
      setNodes([
        { fen: puzzle.fen, by: "start" },
        { fen: setup.fen, uci: puzzle.moves[0], san: setup.san, by: "opp" },
      ]);
      setView(1);
      setPhase("solving");
      startedAt.current = Date.now();
    }, 700);
  }, [puzzle?.id]);

  async function record(solved: boolean) {
    if (!puzzle || recorded.current) return;
    recorded.current = true;
    setResults((r) => [...r, { puzzle, solved }]);
    try {
      const p = await training.recordPuzzle({
        puzzleId: puzzle.id,
        rating: puzzle.rating,
        themes: puzzle.themes,
        weakness: target.title,
        solved,
        hints,
        seconds: (Date.now() - startedAt.current) / 1000,
      });
      onProfile(p);
    } catch (e) {
      setError(String(e));
    }
  }

  function onMove(uci: string) {
    if (!puzzle || phase !== "solving") return;
    const cur = nodes[nodes.length - 1];
    const res = checkPuzzleMove(cur.fen, uci, puzzle.moves, moveIdx);
    if (res.kind === "illegal") return;
    const base = nodes;
    if (res.kind === "wrong") {
      setNodes([...base, { fen: res.fen, uci, san: res.san, by: "you", wrong: true }]);
      setView(base.length);
      setFailed(true);
      setPhase("wrong");
      return;
    }
    const withYou = [...base, { fen: res.fen, uci, san: res.san, by: "you" as const }];
    setNodes(withYou);
    setView(withYou.length - 1);
    if (res.finished) {
      setPhase("done");
      record(!failed && hints === 0 && !revealed);
      return;
    }
    const reply = puzzle.moves[moveIdx + 1];
    const rr = playUci(res.fen, reply);
    const t = token.current;
    setTimeout(() => {
      if (t !== token.current || !rr) return;
      const next = [...withYou, { fen: rr.fen, uci: reply, san: rr.san, by: "opp" as const }];
      setNodes(next);
      setView(next.length - 1);
      setMoveIdx(moveIdx + 2);
      setHints(0);
      if (moveIdx + 2 >= puzzle.moves.length || rr.over) {
        // Line ends on the opponent's move (unusual): count it as solved.
        setPhase("done");
        record(!failed && hints === 0 && !revealed);
      }
    }, 350);
  }

  function tryAgain() {
    const trimmed = nodes.slice(0, -1);
    setNodes(trimmed);
    setView(trimmed.length - 1);
    setPhase("solving");
  }

  function showSolution() {
    if (!puzzle) return;
    let out = nodes.filter((n) => !n.wrong);
    let fen = out[out.length - 1].fen;
    for (let k = moveIdx; k < puzzle.moves.length; k++) {
      const r = playUci(fen, puzzle.moves[k]);
      if (!r) break;
      out = [
        ...out,
        { fen: r.fen, uci: puzzle.moves[k], san: r.san, by: k % 2 === 1 ? "you" : "opp" },
      ];
      fen = r.fen;
    }
    setNodes(out);
    setView(Math.min(out.length - 1, nodes.filter((n) => !n.wrong).length));
    setRevealed(true);
    setPhase("done");
    record(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setView((v) => Math.max(0, v - 1));
      if (e.key === "ArrowRight") setView((v) => Math.min(nodes.length - 1, v + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes.length]);

  if (error && !puzzles?.length)
    return (
      <Alert color="yellow" title="Can't start puzzles">
        {error}
        <Button mt="sm" size="xs" variant="light" onClick={onExit}>
          Back
        </Button>
      </Alert>
    );
  if (!puzzles) return <Loader />;

  // Session summary
  if (!puzzle) {
    const solved = results.filter((r) => r.solved).length;
    const delta = profile.rating - startRating;
    return (
      <Card withBorder maw={560}>
        <Stack>
          <Title order={4}>Session complete: {target.title}</Title>
          <Text>
            Solved {solved} of {results.length} on the first try ({pct(solved, results.length)}).
          </Text>
          <Text>
            Coach puzzle rating: <b>{profile.rating}</b> ({delta >= 0 ? "+" : ""}
            {delta})
          </Text>
          <Group>
            <Button onClick={load}>Another {SESSION_SIZE}</Button>
            <Button variant="light" onClick={onExit}>
              Back
            </Button>
          </Group>
        </Stack>
      </Card>
    );
  }

  const current = nodes[view];
  const atEnd = view === nodes.length - 1;
  const youColor = nodes[1] ? (nodes[1].fen.split(" ")[1] === "w" ? "white" : "black") : "white";
  const expected = phase === "solving" ? puzzle.moves[moveIdx] : null;

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs">
        <MistakeBoard
          fen={current?.fen ?? puzzle.fen}
          orientation={youColor}
          lastMove={current?.uci ?? null}
          onMove={phase === "solving" && atEnd ? onMove : undefined}
          highlightSquare={
            phase === "solving" && hints >= 1 && expected ? expected.slice(0, 2) : null
          }
        />
        <Group justify="center" gap={4}>
          <ActionIcon
            variant="subtle"
            onClick={() => setView((v) => Math.max(0, v - 1))}
            disabled={view === 0}
          >
            <IconChevronLeft size="1.1rem" />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            onClick={() => setView((v) => Math.min(nodes.length - 1, v + 1))}
            disabled={atEnd}
          >
            <IconChevronRight size="1.1rem" />
          </ActionIcon>
        </Group>
      </Stack>

      <Stack style={{ flex: 1 }} gap="sm">
        <Group justify="space-between">
          <Title order={4}>
            {phase === "done"
              ? revealed || failed
                ? "Solution"
                : "Solved!"
              : `Find the best move for ${youColor}`}
          </Title>
          <Text size="sm" c="dimmed">
            {i + 1} / {puzzles.length}
          </Text>
        </Group>
        <Group gap={6}>
          <Badge leftSection={<IconTarget size="0.8rem" />} color="grape" variant="light">
            {target.title}
          </Badge>
          <Badge variant="outline">Puzzle {puzzle.rating}</Badge>
          <Badge variant="outline" color="gray">
            Your rating {profile.rating}
          </Badge>
        </Group>
        <Progress value={(results.length / puzzles.length) * 100} size="sm" />

        <Group gap={4}>
          {nodes.slice(1).map((n, k) => (
            <Button
              key={`${k}-${n.uci}`}
              size="compact-sm"
              variant={view === k + 1 ? "filled" : "light"}
              color={n.wrong ? "red" : n.by === "you" ? "green" : "dark"}
              onClick={() => setView(k + 1)}
            >
              {n.san}
            </Button>
          ))}
        </Group>

        {phase === "solving" && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconBulb size="0.9rem" />}
              onClick={() => setHints(1)}
              disabled={hints >= 1}
            >
              Hint
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={showSolution}>
              Show solution
            </Button>
          </Group>
        )}

        {phase === "wrong" && (
          <>
            <Alert color="red" icon={<IconX />} p="xs">
              {nodes[nodes.length - 1]?.san} isn't it. Look again.
            </Alert>
            <Group gap="xs">
              <Button size="xs" leftSection={<IconArrowBackUp size="0.9rem" />} onClick={tryAgain}>
                Try again
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={showSolution}>
                Show solution
              </Button>
            </Group>
          </>
        )}

        {phase === "done" && (
          <>
            <Alert
              color={!failed && !revealed && hints === 0 ? "green" : "orange"}
              icon={!failed && !revealed && hints === 0 ? <IconCheck /> : <IconX />}
              p="xs"
            >
              {!failed && !revealed && hints === 0
                ? "Solved on the first try."
                : "Counts as a miss for your rating. Step through the solution with the arrows."}
            </Alert>
            <Group gap={4}>
              <Text size="xs" c="dimmed">
                Themes:
              </Text>
              {puzzle.themes.map((t) => (
                <Badge
                  key={t}
                  size="xs"
                  variant="light"
                  color={target.themes.includes(t) ? "grape" : "gray"}
                >
                  {themeLabel(t)}
                </Badge>
              ))}
            </Group>
            <Group>
              <Button onClick={() => setI((x) => x + 1)}>
                {i + 1 < puzzles.length ? "Next puzzle" : "Finish"}
              </Button>
              <Button variant="subtle" color="gray" onClick={onExit}>
                End session
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Group>
  );
}

export default function CoachPuzzles({
  insight,
  initialTarget,
  onTargetUsed,
}: {
  insight: Insight | null;
  initialTarget: PracticeTarget | null;
  onTargetUsed: () => void;
}) {
  const selectedDb = useAtomValue(selectedPuzzleDbAtom);
  const [db, setDb] = useState<string | null | undefined>(undefined);
  const [profile, setProfile] = useState<PuzzleProfile | null>(null);
  const [target, setTarget] = useState<PracticeTarget | null>(null);
  const [custom, setCustom] = useState<string[]>([]);

  useEffect(() => {
    training
      .puzzleProfile()
      .then(setProfile)
      .catch(() => {});
    getPuzzleDatabases()
      .then((dbs) => {
        const chosen = dbs.find((d) => d.path === selectedDb) ?? dbs[0];
        setDb(chosen?.path ?? null);
      })
      .catch(() => setDb(null));
  }, [selectedDb]);

  useEffect(() => {
    if (initialTarget) {
      setTarget(initialTarget);
      onTargetUsed();
    }
  }, [initialTarget, onTargetUsed]);

  if (db === undefined || !profile) return <Loader />;
  if (db === null)
    return (
      <Alert color="yellow" title="No puzzle database yet" maw={560}>
        Open a new board tab, choose <b>Puzzles</b>, and add the Lichess puzzle database. Then come
        back here and the coach will pick puzzles for your weaknesses.
      </Alert>
    );

  if (target)
    return (
      <PuzzleSession
        db={db}
        target={target}
        profile={profile}
        onProfile={setProfile}
        onExit={() => {
          setTarget(null);
          training
            .puzzleProfile()
            .then(setProfile)
            .catch(() => {});
        }}
      />
    );

  const weaknesses = (insight?.weaknesses ?? [])
    .filter((w) => w.puzzleThemes.length > 0)
    .sort((a, b) => a.priority - b.priority);

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 3 }} maw={720}>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Coach puzzle rating
          </Text>
          <Text fz={26} fw={700}>
            {profile.rating}
          </Text>
          <Text size="xs" c="dimmed">
            Puzzles are picked within ±150 of this
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Puzzles done
          </Text>
          <Text fz={26} fw={700}>
            {profile.attempts}
          </Text>
        </Card>
        <Card withBorder p="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            First-try solve rate
          </Text>
          <Text fz={26} fw={700}>
            {pct(profile.solved, profile.attempts)}
          </Text>
        </Card>
      </SimpleGrid>

      <Title order={5}>Practice your weaknesses</Title>
      {weaknesses.length === 0 && (
        <Text size="sm" c="dimmed">
          Run “Analyse my patterns” on the Overview tab and the coach will suggest puzzle themes for
          your weaknesses. You can also pick themes yourself below.
        </Text>
      )}
      {weaknesses.map((w) => {
        const s = themeSummary(profile.themeStats, w.puzzleThemes);
        return (
          <Card key={w.title} withBorder p="sm" maw={720}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={4}>
                <Group gap="xs">
                  <Badge color={w.priority === 1 ? "red" : w.priority === 2 ? "orange" : "gray"}>
                    P{w.priority}
                  </Badge>
                  <Text fw={600}>{w.title}</Text>
                </Group>
                <Group gap={4}>
                  {w.puzzleThemes.map((t) => (
                    <Badge key={t} size="xs" variant="light" color="grape">
                      {themeLabel(t)}
                    </Badge>
                  ))}
                </Group>
                <Text size="xs" c="dimmed">
                  {s.attempts === 0
                    ? "No puzzles yet"
                    : `Solved ${s.solved}/${s.attempts} (${pct(s.solved, s.attempts)}) · last 7 days ${pct(
                        s.recentSolved,
                        s.recentAttempts,
                      )}`}
                </Text>
              </Stack>
              <Button
                leftSection={<IconPuzzle size="1rem" />}
                onClick={() => setTarget({ title: w.title, themes: w.puzzleThemes })}
              >
                Practice {SESSION_SIZE}
              </Button>
            </Group>
          </Card>
        );
      })}

      <Card withBorder p="sm" maw={720}>
        <Stack gap="xs">
          <Text fw={600}>Pick themes yourself</Text>
          <Group align="flex-end">
            <MultiSelect
              style={{ flex: 1 }}
              data={PICKABLE_THEMES.map((t) => ({ value: t, label: themeLabel(t) }))}
              value={custom}
              onChange={setCustom}
              placeholder="e.g. Fork, Pin"
              searchable
              clearable
            />
            <Button
              disabled={custom.length === 0}
              onClick={() =>
                setTarget({ title: custom.map(themeLabel).join(" + "), themes: custom })
              }
            >
              Practice {SESSION_SIZE}
            </Button>
          </Group>
        </Stack>
      </Card>

      {profile.themeStats.length > 0 && (
        <Card withBorder p="sm" maw={720}>
          <Text fw={600} mb="xs">
            By theme
          </Text>
          <Stack gap={6}>
            {profile.themeStats.slice(0, 12).map((t) => (
              <div key={t.theme}>
                <Group justify="space-between" gap={4}>
                  <Text size="xs">{themeLabel(t.theme)}</Text>
                  <Text size="xs" c="dimmed">
                    {t.solved}/{t.attempts} · {pct(t.solved, t.attempts)}
                  </Text>
                </Group>
                <Progress
                  value={t.attempts ? (t.solved / t.attempts) * 100 : 0}
                  size="sm"
                  color="grape"
                />
              </div>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
