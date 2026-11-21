// "Today": the coach's lesson for the day. One ordered checklist, one button.
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconCheck,
  IconPlayerSkipForward,
  IconArrowBackUp,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectedPuzzleDbAtom } from "@/state/atoms";
import { getPuzzleDatabases } from "@/utils/puzzles";
import {
  type DayActivity,
  type Insight,
  type MaiaStatus,
  type MaiaSummary,
  type PuzzleProfile,
  primaryLabel,
  type TodayCounts,
  type TrainingStats,
  training,
} from "@/utils/training";
import { connectedAccounts } from "../autoAnalyze";
import { type Game, InstallCard, PlayGame, playSetupAtom } from "../CoachPlay";
import { PuzzleSession } from "../CoachPuzzles";
import MistakeDrill from "../MistakeDrill";
import { TIME_CONTROLS } from "../playLogic";
import { coachMessage, stepIntro } from "./coachVoice";
import {
  type Focus,
  type LessonPlan,
  type LessonStep,
  planLesson,
  type StepId,
  streak as computeStreak,
  type Weekday,
  WEEKDAY_NAMES,
} from "./lessonPlan";
import { COACH_SERIF, lessonPrefsAtom, tzOffsetMinutes } from "./settings";
import { CheckinStep, LookBackStep, OnlineStep } from "./steps";

type Data = {
  today: TodayCounts;
  history: DayActivity[];
  stats: TrainingStats | null;
  insight: Insight | null;
  maia: MaiaStatus | null;
  maiaSummary: MaiaSummary | null;
  puzzleDb: string | null;
  profile: PuzzleProfile | null;
  lastGamePattern: string | null;
};

export function focusFromInsight(insight: Insight | null): Focus | null {
  const w = [...(insight?.weaknesses ?? [])].sort((a, b) => a.priority - b.priority)[0];
  return w ? { title: w.title, themes: w.puzzleThemes, rule: w.ruleOfThumb } : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);
}

async function loadData(selectedDb: string | null): Promise<Data> {
  const tz = tzOffsetMinutes();
  const safe = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [today, history, stats, insight, maia, maiaSummary, dbs, profile, recent] =
    await Promise.all([
      training.today(tz),
      safe(training.history(120, tz), [] as DayActivity[]),
      safe(training.stats(), null),
      safe(training.latestInsight(), null),
      safe(training.maiaStatus(), null),
      safe(training.maiaSummary(), null),
      safe(getPuzzleDatabases(), []),
      safe(training.puzzleProfile(), null),
      safe(training.mistakes({ limit: 40 }), []),
    ]);
  const db = dbs.find((d) => d.path === selectedDb) ?? dbs[0];
  // Costliest serious mistake in the most recent analysed game.
  const lastGame = recent[0]?.gameId;
  const worst = recent
    .filter((m) => m.gameId === lastGame && m.severity !== "inaccuracy")
    .sort((a, b) => b.winDrop - a.winDrop)[0];
  return {
    today,
    history,
    stats,
    insight,
    maia,
    maiaSummary,
    puzzleDb: db?.path ?? null,
    profile,
    lastGamePattern: worst ? primaryLabel(worst.tags) : null,
  };
}

function WeekStrip({
  history,
  trainingDays,
  todayDate,
}: {
  history: DayActivity[];
  trainingDays: Weekday[];
  todayDate: string;
}) {
  const byDate = new Map(history.map((h) => [h.date, h]));
  const today = new Date(`${todayDate}T12:00:00`);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, k) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + k);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { iso, weekday: d.getDay() as Weekday };
  });
  return (
    <Group gap={6} aria-label="This week">
      {days.map(({ iso, weekday }) => {
        const done = byDate.get(iso)?.lessonComplete ?? false;
        const isToday = iso === todayDate;
        const planned = trainingDays.includes(weekday);
        return (
          <Tooltip
            key={iso}
            label={`${WEEKDAY_NAMES[weekday]}${planned ? "" : " (rest)"}${done ? ": lesson done" : ""}`}
          >
            <Box
              data-testid={`week-${iso}`}
              data-done={done || undefined}
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 600,
                background: done ? "var(--mantine-primary-color-filled)" : "transparent",
                color: done
                  ? "white"
                  : planned
                    ? "var(--mantine-color-text)"
                    : "var(--mantine-color-dimmed)",
                border: isToday
                  ? "2px solid var(--mantine-primary-color-filled)"
                  : planned
                    ? "1px solid var(--mantine-color-default-border)"
                    : "1px dashed var(--mantine-color-default-border)",
              }}
            >
              {WEEKDAY_NAMES[weekday][0]}
            </Box>
          </Tooltip>
        );
      })}
    </Group>
  );
}

function StepRow({
  step,
  index,
  current,
  onStart,
  onSkip,
  onUnskip,
}: {
  step: LessonStep;
  index: number;
  current: boolean;
  onStart: () => void;
  onSkip: () => void;
  onUnskip: () => void;
}) {
  const showProgress = step.target > 1 && !step.done;
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      data-testid={`step-${step.id}`}
      style={{
        borderColor: current ? "var(--mantine-primary-color-filled)" : undefined,
        opacity: step.done ? 0.6 : 1,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <UnstyledButton onClick={onStart} style={{ flex: 1 }} aria-label={`Start ${step.title}`}>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon
              radius="xl"
              size={28}
              variant={step.done ? "filled" : current ? "light" : "default"}
              color={step.skipped ? "gray" : undefined}
            >
              {step.done && !step.skipped ? (
                <IconCheck size={16} />
              ) : (
                <Text size="xs" fw={700}>
                  {index + 1}
                </Text>
              )}
            </ThemeIcon>
            <div>
              <Text fw={600} td={step.skipped ? "line-through" : undefined}>
                {step.title}
              </Text>
              <Text size="sm" c="dimmed">
                {step.skipped ? "Skipped" : step.detail}
                {showProgress ? ` · ${step.progress}/${step.target}` : ""}
              </Text>
            </div>
          </Group>
        </UnstyledButton>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {step.minutes} min
          </Text>
          {step.skipped ? (
            <Tooltip label="Undo skip">
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={onUnskip}
                aria-label={`Undo skip ${step.title}`}
              >
                <IconArrowBackUp size={16} />
              </ActionIcon>
            </Tooltip>
          ) : (
            !step.done && (
              <Tooltip label="Skip today">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={onSkip}
                  aria-label={`Skip ${step.title}`}
                >
                  <IconPlayerSkipForward size={16} />
                </ActionIcon>
              </Tooltip>
            )
          )}
        </Group>
      </Group>
    </Paper>
  );
}

function StepShell({
  title,
  intro,
  onBack,
  children,
}: {
  title: string;
  intro: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconArrowLeft size={14} />}
          onClick={onBack}
        >
          Lesson
        </Button>
        <Title order={4}>{title}</Title>
      </Group>
      <Text style={{ fontFamily: COACH_SERIF }} size="md" c="dimmed">
        {intro}
      </Text>
      {children}
    </Stack>
  );
}

function ActiveStep({
  id,
  plan,
  data,
  focus,
  onBack,
  onData,
}: {
  id: StepId;
  plan: LessonPlan;
  data: Data;
  focus: Focus | null;
  onBack: () => void;
  onData: (d: Partial<Data>) => void;
}) {
  const setup = useAtomValue(playSetupAtom);
  const [game, setGame] = useState<Game | null>(null);
  const step = plan.steps.find((s) => s.id === id);
  const remaining = Math.max(1, (step?.target ?? 1) - (step?.progress ?? 0));
  const date = data.today.date;
  const intro = stepIntro(id, focus);
  const title = step?.title ?? "";

  const shell = (children: React.ReactNode) => (
    <StepShell title={title} intro={intro} onBack={onBack}>
      {children}
    </StepShell>
  );

  if ((id === "warmup" || id === "focus") && data.puzzleDb && data.profile) {
    const target =
      id === "warmup"
        ? { title: "Warm-up", themes: [] }
        : focus && focus.themes.length > 0
          ? { title: focus.title, themes: focus.themes }
          : { title: "Tactics", themes: [] };
    return shell(
      <PuzzleSession
        db={data.puzzleDb}
        target={target}
        profile={data.profile}
        onProfile={(p) => onData({ profile: p })}
        onExit={onBack}
        count={remaining}
        ratingOffset={id === "warmup" ? -300 : 0}
        exitLabel="Back to lesson"
      />,
    );
  }
  if (id === "review")
    return shell(
      <MistakeDrill limit={remaining} onFinished={onBack} finishLabel="Back to lesson" />,
    );
  if (id === "play") {
    if (!data.maia?.installed)
      return shell(<InstallCard onInstalled={(s) => onData({ maia: s })} />);
    const elo = setup.elo ?? data.maiaSummary?.suggestedElo ?? 1100;
    const newGame = (e: number): Game => ({
      id: `${Date.now()}`,
      you: setup.color === "random" ? (Math.random() < 0.5 ? "white" : "black") : setup.color,
      elo: e,
      tc: TIME_CONTROLS.find((t) => t.id === setup.tc) ?? TIME_CONTROLS[0],
      allowHints: setup.hints,
      allowTakebacks: setup.takebacks,
    });
    if (!game)
      return shell(
        <Card withBorder maw={560}>
          <Stack gap="sm">
            <Text size="sm">
              Opponent: Maia at {elo}. Your colour: {setup.color}. Change these on the Play tab.
            </Text>
            <Group>
              <Button onClick={() => setGame(newGame(elo))}>Start the game</Button>
            </Group>
          </Stack>
        </Card>,
      );
    return (
      <PlayGame
        game={game}
        onExit={onBack}
        onRematch={(e) => setGame(newGame(e))}
        goal={focus?.rule ?? null}
        exitLabel="Back to lesson"
      />
    );
  }
  if (id === "lookback")
    return shell(<LookBackStep date={date} tz={tzOffsetMinutes()} onDone={onBack} />);
  if (id === "online") return shell(<OnlineStep date={date} onDone={onBack} />);
  if (id === "checkin") return shell(<CheckinStep date={date} onDone={onBack} />);
  return shell(
    <Alert color="yellow" maw={560}>
      This step needs a puzzle database. Open a new board tab, choose Puzzles, and add the Lichess
      puzzle database.
    </Alert>,
  );
}

export default function TodayLesson({ onDataChanged }: { onDataChanged?: () => void }) {
  const prefs = useAtomValue(lessonPrefsAtom);
  const selectedDb = useAtomValue(selectedPuzzleDbAtom);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<StepId | null>(null);

  const reload = useCallback(() => {
    loadData(selectedDb)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [selectedDb]);

  useEffect(() => {
    reload();
  }, [reload]);

  const focus = useMemo(() => focusFromInsight(data?.insight ?? null), [data?.insight]);

  const plan = useMemo(() => {
    if (!data) return null;
    const weekday = new Date(`${data.today.date}T12:00:00`).getDay() as Weekday;
    const since = data.today.latestInsightDate
      ? daysBetween(data.today.latestInsightDate, data.today.date)
      : null;
    return planLesson({
      weekday,
      settings: prefs,
      forceLesson: data.today.marks.includes("train_anyway"),
      today: data.today,
      dueDrills: data.stats?.cardsDue ?? 0,
      focus,
      maiaElo: data.maiaSummary?.suggestedElo ?? 1100,
      maiaInstalled: data.maia?.installed ?? false,
      puzzleDbAvailable: data.puzzleDb !== null,
      hasOnlineAccounts: connectedAccounts().length > 0,
      daysSinceInsight: since,
      totalMistakes: data.stats?.mistakes ?? 0,
    });
  }, [data, prefs, focus]);

  // Record a finished lesson once, so the streak and week strip see it.
  const recordedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !plan) return;
    if (
      plan.kind === "lesson" &&
      plan.complete &&
      !data.today.marks.includes("lesson_complete") &&
      recordedFor.current !== data.today.date
    ) {
      recordedFor.current = data.today.date;
      training
        .setMark(data.today.date, "lesson_complete", true)
        .then(reload)
        .catch(() => {});
    }
  }, [data, plan, reload]);

  if (error)
    return (
      <Alert color="red" title="Couldn't load today's lesson">
        {error}
      </Alert>
    );
  if (!data || !plan) return <Loader />;

  const mark = async (m: string, on: boolean) => {
    await training.setMark(data.today.date, m, on).catch(() => {});
    reload();
  };

  if (active)
    return (
      <ActiveStep
        id={active}
        plan={plan}
        data={data}
        focus={focus}
        onBack={() => {
          setActive(null);
          reload();
          onDataChanged?.();
        }}
        onData={(d) => setData((old) => (old ? { ...old, ...d } : old))}
      />
    );

  const trainingDays = prefs.trainingDays;
  const streak = computeStreak(data.history, trainingDays);
  const lessonsDone = data.history.filter((h) => h.lessonComplete).length;
  const lessonNumber = lessonsDone + (plan.complete ? 0 : 1);
  const hasAnyData = (data.stats?.games ?? 0) > 0 || (data.maiaSummary?.games ?? 0) > 0;
  const message = coachMessage({
    hour: new Date().getHours(),
    name: prefs.name,
    plan,
    focus,
    streak,
    lastGamePattern: data.lastGamePattern,
    hasAnyData,
    daySeed: Number(data.today.date.replaceAll("-", "")),
  });
  const current = plan.steps.find((s) => s.id === plan.currentId) ?? null;
  const remainingMin = plan.steps.filter((s) => !s.done).reduce((a, s) => a + s.minutes, 0);
  const dateLabel = new Date(`${data.today.date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const started = plan.steps.some((s) => s.done || s.progress > 0);

  return (
    <Stack gap="lg" maw={720}>
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="sm" c="dimmed">
            {dateLabel}
            {plan.kind === "lesson" ? ` · Lesson ${lessonNumber}` : " · Rest day"}
            {streak > 0 ? ` · ${streak} in a row` : ""}
          </Text>
          {plan.kind === "lesson" && !plan.complete && (
            <Text size="sm" c="dimmed">
              About {remainingMin} minutes left
            </Text>
          )}
        </div>
        <WeekStrip history={data.history} trainingDays={trainingDays} todayDate={data.today.date} />
      </Group>

      <Text
        style={{ fontFamily: COACH_SERIF, lineHeight: 1.5 }}
        fz={22}
        data-testid="coach-message"
      >
        {message}
      </Text>

      {focus && plan.kind === "lesson" && (
        <Card withBorder radius="md" p="sm" bg="var(--mantine-color-default-hover)">
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            This week's focus
          </Text>
          <Text fw={600}>{focus.title}</Text>
          <Text size="sm">{focus.rule}</Text>
        </Card>
      )}

      {plan.steps.length > 0 && (
        <Stack gap="xs">
          {plan.steps.map((s, i) => (
            <StepRow
              key={s.id}
              step={s}
              index={i}
              current={s.id === plan.currentId}
              onStart={() => setActive(s.id)}
              onSkip={() => mark(`skip:${s.id}`, true)}
              onUnskip={() => mark(`skip:${s.id}`, false)}
            />
          ))}
        </Stack>
      )}

      <Group>
        {current && (
          <Button size="md" onClick={() => setActive(current.id)}>
            {started ? `Continue: ${current.title}` : `Start: ${current.title}`}
          </Button>
        )}
        {plan.kind === "rest" && (
          <Button variant="light" onClick={() => mark("train_anyway", true)}>
            Train anyway
          </Button>
        )}
      </Group>
    </Stack>
  );
}
