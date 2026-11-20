import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowBackUp,
  IconBulb,
  IconChevronLeft,
  IconChevronRight,
  IconFlag,
  IconPlayerPause,
  IconPlayerPlay,
  IconRobot,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, events } from "@/bindings";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { createTab } from "@/utils/tabs";
import {
  coachIngestSettingsAtom,
  MAIA_INSTALL_PROGRESS_ID,
  type MaiaStatus,
  type MaiaSummary,
  training,
} from "@/utils/training";
import { analyzePgnFile, pickEngine } from "./autoAnalyze";
import { playUci } from "./drillLogic";
import { MistakeBoard, uciToShape } from "./MistakeBoard";
import {
  buildPgn,
  formatClock,
  type GameEnd,
  gameEnd,
  humanDelay,
  replay,
  resultFor,
  START_FEN,
  type TimeControl,
  TIME_CONTROLS,
  takebackPlies,
  toChessComRapid,
} from "./playLogic";

const YOU = "You";

type Setup = {
  elo: number | null;
  color: "white" | "black" | "random";
  tc: string;
  hints: boolean;
  takebacks: boolean;
};

export const playSetupAtom = atomWithStorage<Setup>("coach-play-setup", {
  elo: null,
  color: "random",
  tc: "none",
  hints: true,
  takebacks: true,
});

type Game = {
  id: string;
  you: "white" | "black";
  elo: number;
  tc: TimeControl;
  allowHints: boolean;
  allowTakebacks: boolean;
};

function installMessage(p: number): string {
  if (p < 8) return "Downloading the Python package manager…";
  if (p < 20) return "Setting up a private Python…";
  if (p < 85) return "Installing PyTorch and Maia-3 (about 200 MB; this is the long step)…";
  if (p < 95) return "Downloading the Maia-3 model…";
  return "Testing the engine…";
}

function InstallCard({ onInstalled }: { onInstalled: (s: MaiaStatus) => void }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const un = events.progressEvent.listen(({ payload }) => {
      if (payload.id === MAIA_INSTALL_PROGRESS_ID && !payload.finished)
        setProgress(payload.progress);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function install() {
    setRunning(true);
    setError(null);
    setProgress(1);
    try {
      onInstalled(await training.maiaInstall());
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card withBorder maw={640}>
      <Stack gap="sm">
        <Title order={4}>
          <IconRobot size="1.1rem" /> Human-like opponent (Maia-3)
        </Title>
        <Text size="sm">
          Maia-3 is a research engine from the University of Toronto that plays the moves real
          people at a chosen rating would play, mistakes included, from about 250 to 2250 Chess.com
          rapid.
        </Text>
        <Text size="sm" c="dimmed">
          One-time setup: the app installs a private copy of Python, PyTorch and Maia-3 in its own
          folder. About 200 MB download and 1 GB on disk; a few minutes. Nothing is changed outside
          the app's folder, and you can remove it any time.
        </Text>
        {running && (
          <>
            <Progress value={progress} animated />
            <Text size="sm">{installMessage(progress)}</Text>
          </>
        )}
        {error && (
          <Alert color="red" title="Setup failed" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </Alert>
        )}
        <Group>
          <Button onClick={install} loading={running}>
            {error ? "Try again" : "Set up Maia-3"}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function Stats({ summary }: { summary: MaiaSummary }) {
  if (summary.games === 0) return null;
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} maw={900}>
      <Card withBorder p="sm">
        <Text fw={600} mb={6}>
          Results by level
        </Text>
        <Table withRowBorders={false} verticalSpacing={2}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Maia level</Table.Th>
              <Table.Th>≈ Chess.com</Table.Th>
              <Table.Th>W / D / L</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {summary.byLevel.map((l) => (
              <Table.Tr key={l.elo}>
                <Table.Td>{l.elo}</Table.Td>
                <Table.Td>{toChessComRapid(l.elo)}</Table.Td>
                <Table.Td>
                  {l.wins} / {l.draws} / {l.losses}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Card withBorder p="sm">
        <Text fw={600} mb={6}>
          Openings you face
        </Text>
        {summary.openings.length === 0 && (
          <Text size="sm" c="dimmed">
            Play a few games to see which openings come up.
          </Text>
        )}
        <Stack gap={4}>
          {summary.openings.map((o) => (
            <Group key={`${o.name}-${o.color}`} justify="space-between" wrap="nowrap">
              <Text size="sm" truncate>
                {o.name}{" "}
                <Text span size="xs" c="dimmed">
                  (as {o.color})
                </Text>
              </Text>
              <Text size="xs" c={o.score >= 50 ? "green" : "red"} style={{ whiteSpace: "nowrap" }}>
                {o.games} game{o.games === 1 ? "" : "s"} · {o.score}%
              </Text>
            </Group>
          ))}
        </Stack>
      </Card>
    </SimpleGrid>
  );
}

export default function CoachPlay() {
  const [status, setStatus] = useState<MaiaStatus | null>(null);
  const [summary, setSummary] = useState<MaiaSummary | null>(null);
  const [setup, setSetup] = useAtom(playSetupAtom);
  const [game, setGame] = useState<Game | null>(null);

  const refresh = useCallback(() => {
    training
      .maiaStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
    training
      .maiaSummary()
      .then(setSummary)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!status || !summary) return <Loader />;
  if (!status.installed) return <InstallCard onInstalled={(s) => setStatus(s)} />;

  if (game)
    return (
      <PlayGame
        game={game}
        onExit={() => {
          setGame(null);
          refresh();
        }}
        onRematch={(elo) => {
          refresh();
          setGame({ ...game, id: `${Date.now()}`, elo });
        }}
      />
    );

  const elo = setup.elo ?? summary.suggestedElo;
  return (
    <Stack>
      <Card withBorder maw={640}>
        <Stack gap="sm">
          <Title order={4}>
            <IconRobot size="1.1rem" /> Play a human-like opponent
          </Title>
          <Group align="flex-end">
            <NumberInput
              label="Maia level"
              description={`≈ Chess.com rapid ${toChessComRapid(elo)}`}
              min={600}
              max={2600}
              step={50}
              value={elo}
              onChange={(v) => setSetup({ ...setup, elo: Number(v) || summary.suggestedElo })}
              w={180}
            />
            {elo !== summary.suggestedElo && (
              <Button variant="subtle" size="xs" onClick={() => setSetup({ ...setup, elo: null })}>
                Use suggested ({summary.suggestedElo})
              </Button>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            The suggested level adapts: win 2 of your last 3 at a level and it goes up 50; lose them
            and it goes down. The Chess.com number is a rough conversion.
          </Text>
          <Group grow>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Your colour
              </Text>
              <SegmentedControl
                value={setup.color}
                onChange={(v) => setSetup({ ...setup, color: v as Setup["color"] })}
                data={[
                  { value: "white", label: "White" },
                  { value: "random", label: "Random" },
                  { value: "black", label: "Black" },
                ]}
              />
            </Stack>
            <Select
              label="Clock"
              data={TIME_CONTROLS.map((t) => ({ value: t.id, label: t.label }))}
              value={setup.tc}
              onChange={(v) => setSetup({ ...setup, tc: v ?? "none" })}
              allowDeselect={false}
            />
          </Group>
          <Group>
            <Switch
              label="Allow hints"
              checked={setup.hints}
              onChange={(e) => setSetup({ ...setup, hints: e.currentTarget.checked })}
            />
            <Switch
              label="Allow takebacks"
              checked={setup.takebacks}
              onChange={(e) => setSetup({ ...setup, takebacks: e.currentTarget.checked })}
            />
          </Group>
          <Group>
            <Button
              leftSection={<IconPlayerPlay size="1rem" />}
              onClick={() =>
                setGame({
                  id: `${Date.now()}`,
                  you:
                    setup.color === "random"
                      ? Math.random() < 0.5
                        ? "white"
                        : "black"
                      : setup.color,
                  elo,
                  tc: TIME_CONTROLS.find((t) => t.id === setup.tc) ?? TIME_CONTROLS[0],
                  allowHints: setup.hints,
                  allowTakebacks: setup.takebacks,
                })
              }
            >
              Play
            </Button>
            {summary.games > 0 && (
              <Text size="sm" c="dimmed">
                {summary.wins}W · {summary.draws}D · {summary.losses}L overall
              </Text>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            You can pause any time. Finished games are analysed like your online games: mistakes
            become drill cards and count toward your coach insights.
          </Text>
        </Stack>
      </Card>
      <Stats summary={summary} />
      <Group>
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          onClick={async () => {
            setStatus(await training.maiaUninstall());
          }}
        >
          Remove Maia-3 (frees about 1 GB)
        </Button>
      </Group>
    </Stack>
  );
}

function PlayGame({
  game,
  onExit,
  onRematch,
}: {
  game: Game;
  onExit: () => void;
  onRematch: (elo: number) => void;
}) {
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const navigate = useNavigate();

  const [ucis, setUcis] = useState<string[]>([]);
  const { fens, sans } = useMemo(() => replay(START_FEN, ucis), [ucis]);
  // Clocks live in refs (source of truth); `tick` re-renders the display.
  const clocksRef = useRef<{ white: number; black: number } | null>(null);
  const clockLogRef = useRef<(number | null)[]>([]);
  const ucisRef = useRef<string[]>([]);
  ucisRef.current = ucis;
  const [, setTick] = useState(0);
  const clocks = clocksRef.current;
  const [paused, setPaused] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const [end, setEnd] = useState<GameEnd | null>(null);
  const [thinking, setThinking] = useState(false);
  const [hintLevel, setHintLevel] = useState(0);
  const [hintMove, setHintMove] = useState<string | null>(null);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [takebacksUsed, setTakebacksUsed] = useState(0);
  const [post, setPost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const finished = useRef(false);
  const lastTick = useRef(Date.now());

  // Reset when a new game starts (rematch reuses this component).
  useEffect(() => {
    token.current++;
    finished.current = false;
    setUcis([]);
    clocksRef.current = game.tc.baseMs ? { white: game.tc.baseMs, black: game.tc.baseMs } : null;
    clockLogRef.current = [];
    setTick((t) => t + 1);
    setPaused(false);
    setView(null);
    setEnd(null);
    setHintLevel(0);
    setHintMove(null);
    setHintsUsed(0);
    setTakebacksUsed(0);
    setPost(null);
    setError(null);
  }, [game.id]);

  const fen = fens[fens.length - 1];
  const toMove: "white" | "black" = fen.split(" ")[1] === "b" ? "black" : "white";
  const maiaTurn = toMove !== game.you;

  const applyMove = useCallback(
    (uci: string, mover: "white" | "black") => {
      setUcis((u) => [...u, uci]);
      setHintLevel(0);
      setHintMove(null);
      const c = clocksRef.current;
      if (c) {
        c[mover] += game.tc.incMs;
        clockLogRef.current = [...clockLogRef.current, c[mover]];
      } else {
        clockLogRef.current = [...clockLogRef.current, null];
      }
      lastTick.current = Date.now();
    },
    [game.tc.incMs],
  );

  // Game end by rules
  useEffect(() => {
    if (finished.current) return;
    const e = gameEnd(fens);
    if (e) finish(e);
  }, [fens]);

  // Clocks: start once White has moved; stop when paused or over.
  useEffect(() => {
    if (!clocksRef.current || end || paused || ucis.length === 0) return;
    lastTick.current = Date.now();
    const id = setInterval(() => {
      const c = clocksRef.current;
      if (!c) return;
      const now = Date.now();
      c[toMove] = Math.max(0, c[toMove] - (now - lastTick.current));
      lastTick.current = now;
      setTick((t) => t + 1);
      if (c[toMove] <= 0 && !finished.current) {
        finish({ result: toMove === "white" ? "0-1" : "1-0", reason: "time" });
      }
    }, 200);
    return () => clearInterval(id);
  }, [end, paused, toMove, ucis.length]);

  // Maia's move
  useEffect(() => {
    if (end || paused || !maiaTurn) return;
    const t = ++token.current;
    setThinking(true);
    const started = Date.now();
    training
      .maiaMove(START_FEN, ucis, game.elo)
      .then(async (mv) => {
        const wait = humanDelay(ucis.length) - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (t !== token.current) return;
        setThinking(false);
        if (!mv || !playUci(fen, mv)) return;
        applyMove(mv, toMove);
      })
      .catch((e) => {
        if (t !== token.current) return;
        setThinking(false);
        setError(String(e));
      });
    return () => {
      // a takeback, pause or new game invalidates a pending Maia move
      token.current++;
      setThinking(false);
    };
  }, [ucis, paused, end, maiaTurn, game.elo]);

  function onMove(uci: string) {
    if (end || maiaTurn) return;
    if (!playUci(fen, uci)) return;
    if (paused) setPaused(false);
    setView(null);
    applyMove(uci, game.you);
  }

  async function hint() {
    const engine = pickEngine(getDefaultStore().get(coachIngestSettingsAtom).engineId);
    if (!engine) {
      setError("Pick an engine in Coach → Settings for hints.");
      return;
    }
    setHintsUsed((h) => h + 1);
    if (!hintMove) {
      const lines = await training.analyse(engine.path, fen, 14, 1).catch(() => []);
      setHintMove(lines[0]?.pvUci[0] ?? null);
    }
    setHintLevel((l) => Math.min(2, l + 1));
  }

  function takeback() {
    const n = takebackPlies(ucis.length, game.you === "white", thinking);
    if (n === 0) return;
    token.current++;
    setThinking(false);
    setUcis((u) => u.slice(0, -n));
    clockLogRef.current = clockLogRef.current.slice(0, -n);
    setTakebacksUsed((t) => t + 1);
    setHintLevel(0);
    setHintMove(null);
    setView(null);
  }

  async function finish(e: GameEnd) {
    if (finished.current) return;
    finished.current = true;
    token.current++;
    setEnd(e);
    setThinking(false);
    const moves = ucisRef.current;
    const { fens: allFens, sans: allSans } = replay(START_FEN, moves);
    if (moves.length < 2) {
      setPost("Game too short to save.");
      return;
    }
    setPost("Saving game…");
    try {
      const opening = await commands
        .getOpeningFromFens(allFens)
        .then((r) => (r.status === "ok" && r.data ? r.data : null))
        .catch(() => null);
      const now = new Date();
      const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
      const maiaName = `Maia-3 ${game.elo}`;
      const tcHeader = game.tc.baseMs ? `${game.tc.baseMs / 1000}+${game.tc.incMs / 1000}` : "-";
      const headers: Record<string, string> = {
        Event: "Coach: vs Maia-3",
        Site: "En Croissant Coach",
        Date: date,
        UTCDate: date,
        UTCTime: now.toISOString().slice(11, 19),
        White: game.you === "white" ? YOU : maiaName,
        Black: game.you === "black" ? YOU : maiaName,
        Result: e.result,
        TimeControl: tcHeader,
        Termination: e.reason,
        Link: `coach-maia://${game.id}`,
        [game.you === "white" ? "BlackElo" : "WhiteElo"]: String(game.elo),
      };
      if (opening) headers.Opening = opening;
      const clockLogNow = clockLogRef.current;
      const pgn = buildPgn({
        headers,
        sans: allSans,
        clocksMs: game.tc.baseMs ? clockLogNow : undefined,
        result: e.result,
      });
      const path = await training.maiaRecordGame({
        gameId: game.id,
        color: game.you,
        elo: game.elo,
        result: resultFor(e.result, game.you),
        plies: moves.length,
        opening,
        hints: hintsUsed,
        takebacks: takebacksUsed,
        timeControl: game.tc.baseMs ? tcHeader : null,
        pgn,
      });
      setPost("Analysing your moves…");
      const s = await analyzePgnFile(path, YOU);
      setPost(
        s
          ? `Analysed: ${s.mistakesFound} mistake${s.mistakesFound === 1 ? "" : "s"} added to your drills.`
          : "Saved. Pick an engine in Coach → Settings to analyse games automatically.",
      );
    } catch (err) {
      setPost(`Couldn't save the game: ${String(err)}`);
    }
  }

  async function review() {
    const movetext = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
    await createTab({
      tab: { name: `vs Maia-3 ${game.elo}`, type: "analysis" },
      setTabs,
      setActiveTab,
      pgn: movetext,
      headers: {
        id: 0,
        fen: START_FEN,
        event: "Coach: vs Maia-3",
        site: "En Croissant Coach",
        white: game.you === "white" ? YOU : `Maia-3 ${game.elo}`,
        black: game.you === "black" ? YOU : `Maia-3 ${game.elo}`,
        result: end?.result ?? "*",
        orientation: game.you,
      },
    });
    navigate({ to: "/" });
  }

  const shownIdx = view ?? fens.length - 1;
  const atLive = shownIdx === fens.length - 1;
  const outcome = end ? resultFor(end.result, game.you) : null;
  const maiaSide = game.you === "white" ? "black" : "white";

  const ClockBox = ({ side }: { side: "white" | "black" }) =>
    clocks ? (
      <Badge
        size="xl"
        radius="sm"
        variant={toMove === side && !end ? "filled" : "light"}
        color={clocks[side] < 30_000 ? "red" : "gray"}
      >
        {formatClock(clocks[side])}
      </Badge>
    ) : null;

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>
            <IconRobot size="0.9rem" /> Maia-3 {game.elo}{" "}
            <Text span size="xs" c="dimmed">
              (≈ Chess.com {toChessComRapid(game.elo)})
            </Text>
          </Text>
          <ClockBox side={maiaSide} />
        </Group>
        <MistakeBoard
          fen={fens[shownIdx]}
          orientation={game.you}
          lastMove={shownIdx > 0 ? ucis[shownIdx - 1] : null}
          onMove={!end && !maiaTurn && atLive ? onMove : undefined}
          highlightSquare={hintLevel >= 1 && hintMove && atLive ? hintMove.slice(0, 2) : null}
          shapes={
            hintLevel >= 2 && hintMove && atLive
              ? [uciToShape(hintMove, "green")].filter(
                  (s): s is NonNullable<typeof s> => s !== null,
                )
              : []
          }
        />
        <Group justify="space-between">
          <Text fw={600}>{YOU}</Text>
          <ClockBox side={game.you} />
        </Group>
      </Stack>

      <Stack style={{ flex: 1 }} gap="sm">
        <Group justify="space-between">
          <Title order={4}>
            {end
              ? outcome === "win"
                ? "You won!"
                : outcome === "loss"
                  ? "Maia won"
                  : "Draw"
              : paused
                ? "Paused"
                : maiaTurn
                  ? "Maia is thinking…"
                  : "Your move"}
          </Title>
          {thinking && !end && <Loader size="xs" />}
        </Group>
        {end && (
          <Text size="sm" c="dimmed">
            {end.result} by {end.reason}
          </Text>
        )}
        {error && (
          <Alert color="red" p="xs">
            {error}
          </Alert>
        )}

        <Group gap={4}>
          <ActionIcon
            variant="subtle"
            onClick={() => setView(Math.max(0, shownIdx - 1))}
            disabled={shownIdx === 0}
          >
            <IconChevronLeft size="1.1rem" />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            onClick={() => setView(shownIdx + 1 >= fens.length - 1 ? null : shownIdx + 1)}
            disabled={atLive}
          >
            <IconChevronRight size="1.1rem" />
          </ActionIcon>
          {!atLive && (
            <Button size="compact-xs" variant="subtle" onClick={() => setView(null)}>
              Back to the game
            </Button>
          )}
        </Group>
        <Group gap={4} style={{ maxHeight: 180, overflowY: "auto" }}>
          {sans.map((s, i) => (
            <Button
              key={`${i}-${s}`}
              size="compact-xs"
              variant={shownIdx === i + 1 ? "filled" : "subtle"}
              color="gray"
              onClick={() => setView(i + 1 === fens.length - 1 ? null : i + 1)}
            >
              {i % 2 === 0 ? `${i / 2 + 1}. ` : ""}
              {s}
            </Button>
          ))}
        </Group>

        {!end && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              leftSection={
                paused ? <IconPlayerPlay size="0.9rem" /> : <IconPlayerPause size="0.9rem" />
              }
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            {game.allowHints && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconBulb size="0.9rem" />}
                onClick={hint}
                disabled={maiaTurn || hintLevel >= 2}
              >
                {hintLevel === 0 ? "Hint" : "Show move"}
              </Button>
            )}
            {game.allowTakebacks && (
              <Button
                size="xs"
                variant="light"
                color="gray"
                leftSection={<IconArrowBackUp size="0.9rem" />}
                onClick={takeback}
                disabled={ucis.length === 0}
              >
                Takeback
              </Button>
            )}
            <Button
              size="xs"
              variant="subtle"
              color="red"
              leftSection={<IconFlag size="0.9rem" />}
              onClick={() =>
                finish({ result: game.you === "white" ? "0-1" : "1-0", reason: "resignation" })
              }
            >
              Resign
            </Button>
          </Group>
        )}
        {!end && (hintsUsed > 0 || takebacksUsed > 0) && (
          <Text size="xs" c="dimmed">
            Hints used: {hintsUsed} · takebacks: {takebacksUsed}
          </Text>
        )}

        {end && (
          <>
            {post && <Text size="sm">{post}</Text>}
            <Group gap="xs">
              <Button
                leftSection={<IconPlayerPlay size="0.9rem" />}
                onClick={async () => {
                  const s = await training.maiaSummary().catch(() => null);
                  onRematch(s?.suggestedElo ?? game.elo);
                }}
              >
                Play again
              </Button>
              <Button
                variant="light"
                leftSection={<IconZoomCheck size="0.9rem" />}
                onClick={review}
              >
                Review in analysis board
              </Button>
              <Button variant="subtle" color="gray" onClick={onExit}>
                Back
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Tip: the analysis board's Coach tab shows this game's critical moments.
            </Text>
          </>
        )}
      </Stack>
    </Group>
  );
}
