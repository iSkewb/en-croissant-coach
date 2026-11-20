import { LineChart } from "@mantine/charts";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Progress,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { IconPuzzle, IconRefresh, IconSparkles, IconTarget } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { events } from "@/bindings";
import {
  type Insight,
  INGEST_PROGRESS_ID,
  type Mistake,
  type TrainingStats,
  TAG_LABELS,
  tagLabel,
  training,
} from "@/utils/training";
import { analyzeAccount, connectedAccounts } from "./autoAnalyze";
import CoachPuzzles, { type PracticeTarget } from "./CoachPuzzles";
import CoachSettings from "./CoachSettings";
import { MistakeDetail } from "./MistakeDetail";
import MistakeDrill from "./MistakeDrill";

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card withBorder p="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text fz={26} fw={700}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

function AnalyzeGames({ onDone }: { onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = events.progressEvent.listen(({ payload }) => {
      if (payload.id === INGEST_PROGRESS_ID) setProgress(payload.progress);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function run() {
    setRunning(true);
    setError(null);
    setMessage(null);
    const accounts = connectedAccounts();
    if (accounts.length === 0) {
      setError("Connect your Chess.com or Lichess account on the Accounts page first.");
      setRunning(false);
      return;
    }
    let games = 0;
    let mistakes = 0;
    let refreshed = false;
    try {
      for (const acc of accounts) {
        const s = await analyzeAccount(acc);
        if (!s) continue;
        games += s.gamesAnalyzed;
        mistakes += s.mistakesFound;
        refreshed ||= s.insightRefreshed;
        if (s.cancelled) break;
      }
      setMessage(
        games === 0
          ? "No new games. Use “Download games” on the Accounts page to fetch recent ones."
          : `Analysed ${games} game${games === 1 ? "" : "s"}, found ${mistakes} mistakes.${refreshed ? " Coach insights updated." : ""}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      onDone();
    }
  }

  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between">
          <Title order={5}>Your games</Title>
          <Group gap="xs">
            {running && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() => training.cancelIngest()}
              >
                Stop
              </Button>
            )}
            <Button size="xs" onClick={run} loading={running}>
              Analyse new games
            </Button>
          </Group>
        </Group>
        {running && <Progress value={progress} animated />}
        {message && <Text size="sm">{message}</Text>}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function InsightCard({
  insight,
  onOpenMistake,
  onRefreshed,
  onPractice,
}: {
  insight: Insight | null;
  onOpenMistake: (id: number) => void;
  onRefreshed: () => void;
  onPractice: (t: PracticeTarget) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      await training.runInsights();
      onRefreshed();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>
            <IconSparkles size="1rem" /> Coach insights
          </Title>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size="0.9rem" />}
            loading={loading}
            onClick={refresh}
          >
            {insight ? "Refresh" : "Analyse my patterns"}
          </Button>
        </Group>
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        {!insight && !error && (
          <Text size="sm" c="dimmed">
            After a few analysed games, the coach looks across all your mistakes and finds the
            habits that cost you the most.
          </Text>
        )}
        {insight && (
          <>
            <Text size="sm">{insight.summary}</Text>
            {[...insight.weaknesses]
              .sort((a, b) => a.priority - b.priority)
              .map((w) => (
                <Card key={w.title} withBorder p="sm" bg="var(--mantine-color-default-hover)">
                  <Stack gap={4}>
                    <Group gap="xs">
                      <Badge
                        color={w.priority === 1 ? "red" : w.priority === 2 ? "orange" : "gray"}
                      >
                        P{w.priority}
                      </Badge>
                      <Text fw={600}>{w.title}</Text>
                    </Group>
                    <Text size="sm">{w.evidence}</Text>
                    <Text size="sm" fw={500}>
                      Rule: {w.ruleOfThumb}
                    </Text>
                    <Group gap={4}>
                      {w.drillTags.map((t) => (
                        <Badge
                          key={t}
                          size="xs"
                          variant="light"
                          leftSection={<IconTarget size="0.7rem" />}
                        >
                          {tagLabel(t)}
                        </Badge>
                      ))}
                      {w.puzzleThemes.map((t) => (
                        <Badge key={t} size="xs" variant="outline" color="grape">
                          puzzles: {t}
                        </Badge>
                      ))}
                    </Group>
                    {w.puzzleThemes.length > 0 && (
                      <Group>
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="grape"
                          leftSection={<IconPuzzle size="0.8rem" />}
                          onClick={() => onPractice({ title: w.title, themes: w.puzzleThemes })}
                        >
                          Practice with puzzles
                        </Button>
                      </Group>
                    )}
                    {w.mistakeIds.length > 0 && (
                      <Group gap={4}>
                        <Text size="xs" c="dimmed">
                          Examples:
                        </Text>
                        {w.mistakeIds.map((id) => (
                          <Button
                            key={id}
                            size="compact-xs"
                            variant="subtle"
                            onClick={() => onOpenMistake(id)}
                          >
                            #{id}
                          </Button>
                        ))}
                      </Group>
                    )}
                  </Stack>
                </Card>
              ))}
            {insight.plan.length > 0 && (
              <>
                <Text fw={600} size="sm">
                  This week
                </Text>
                <List size="sm">
                  {insight.plan.map((p) => (
                    <List.Item key={p}>{p}</List.Item>
                  ))}
                </List>
              </>
            )}
            {insight.strengths.length > 0 && (
              <Text size="sm" c="dimmed">
                Strengths: {insight.strengths.join(" · ")}
              </Text>
            )}
            {insight.progressNote && (
              <Text size="sm" c="dimmed">
                Progress: {insight.progressNote}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              Based on {insight.mistakesAnalyzed} mistakes · {insight.createdAt}
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}

function CountBars({
  title,
  rows,
  label = (k: string) => k,
}: {
  title: string;
  rows: { key: string; count: number }[];
  label?: (k: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card withBorder>
      <Title order={6} mb="xs">
        {title}
      </Title>
      <Stack gap={6}>
        {rows.length === 0 && (
          <Text size="sm" c="dimmed">
            No data yet
          </Text>
        )}
        {rows.slice(0, 8).map((r) => (
          <div key={r.key}>
            <Group justify="space-between" gap={4}>
              <Text size="xs">{label(r.key)}</Text>
              <Text size="xs" c="dimmed">
                {r.count}
              </Text>
            </Group>
            <Progress value={(r.count / max) * 100} size="sm" />
          </div>
        ))}
      </Stack>
    </Card>
  );
}

function Overview({
  stats,
  insight,
  reload,
  openMistake,
  onPractice,
}: {
  stats: TrainingStats | null;
  insight: Insight | null;
  reload: () => void;
  openMistake: (id: number) => void;
  onPractice: (t: PracticeTarget) => void;
}) {
  // Exclude pure context tags from the "what goes wrong" chart.
  const contextTags = new Set(["was_winning", "was_losing", "time_pressure", "rushed"]);
  return (
    <Stack>
      <AnalyzeGames onDone={reload} />
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <StatTile label="Games analysed" value={String(stats?.games ?? 0)} />
        <StatTile
          label="Mistakes / game"
          value={(stats?.mistakesPerGame ?? 0).toFixed(1)}
          hint="mistakes + blunders"
        />
        <StatTile label="Blunders" value={String(stats?.blunders ?? 0)} />
        <StatTile
          label="Drills due"
          value={String(stats?.cardsDue ?? 0)}
          hint={`${stats?.cardsTotal ?? 0} in deck`}
        />
      </SimpleGrid>
      <InsightCard
        insight={insight}
        onOpenMistake={openMistake}
        onRefreshed={reload}
        onPractice={onPractice}
      />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <CountBars
          title="What goes wrong"
          rows={(stats?.byTag ?? []).filter((r) => !contextTags.has(r.key))}
          label={tagLabel}
        />
        <CountBars
          title="When it goes wrong"
          rows={[
            ...(stats?.byPhase ?? []),
            ...(stats?.byTag ?? [])
              .filter((r) => contextTags.has(r.key))
              .map((r) => ({ ...r, key: tagLabel(r.key) })),
          ]}
        />
        <CountBars title="By opening" rows={stats?.byOpening ?? []} />
        <CountBars title="By time control" rows={stats?.byTimeControl ?? []} />
      </SimpleGrid>
      {(stats?.monthlyRate.length ?? 0) > 1 && (
        <Card withBorder>
          <Title order={6} mb="xs">
            Mistakes per game over time
          </Title>
          <LineChart
            h={220}
            data={stats!.monthlyRate}
            dataKey="month"
            series={[{ name: "mistakesPerGame", label: "Mistakes / game", color: "red.6" }]}
            curveType="monotone"
          />
        </Card>
      )}
    </Stack>
  );
}

function MistakeList({ openMistake }: { openMistake: (m: Mistake) => void }) {
  const [tag, setTag] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [severity, setSeverity] = useState<string | null>(null);
  const [rows, setRows] = useState<Mistake[]>([]);

  useEffect(() => {
    training
      .mistakes({ tag, phase, severity, limit: 300 })
      .then(setRows)
      .catch(() => setRows([]));
  }, [tag, phase, severity]);

  return (
    <Stack>
      <Group>
        <Select
          placeholder="Any pattern"
          clearable
          data={Object.entries(TAG_LABELS).map(([value, label]) => ({ value, label }))}
          value={tag}
          onChange={setTag}
        />
        <Select
          placeholder="Any phase"
          clearable
          data={["opening", "middlegame", "endgame"]}
          value={phase}
          onChange={setPhase}
        />
        <Select
          placeholder="Any severity"
          clearable
          data={["blunder", "mistake", "inaccuracy"]}
          value={severity}
          onChange={setSeverity}
        />
        <Text size="sm" c="dimmed">
          {rows.length} shown
        </Text>
      </Group>
      <ScrollArea h="calc(100vh - 220px)">
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Opponent</Table.Th>
              <Table.Th>Move</Table.Th>
              <Table.Th>Played / Best</Table.Th>
              <Table.Th>Win % lost</Table.Th>
              <Table.Th>Patterns</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((m) => (
              <Table.Tr key={m.id} style={{ cursor: "pointer" }} onClick={() => openMistake(m)}>
                <Table.Td>{m.date}</Table.Td>
                <Table.Td>{m.opponent}</Table.Td>
                <Table.Td>{Math.floor(m.ply / 2) + 1}</Table.Td>
                <Table.Td>
                  <Text span c="red">
                    {m.playedSan}
                  </Text>{" "}
                  /{" "}
                  <Text span c="green">
                    {m.bestSan}
                  </Text>
                </Table.Td>
                <Table.Td>{Math.round(m.winDrop)}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {m.tags.map((t) => (
                      <Badge key={t} size="xs" variant="light" color="gray">
                        {tagLabel(t)}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Stack>
  );
}

export default function CoachPage() {
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [selected, setSelected] = useState<Mistake | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>("overview");
  const [practice, setPractice] = useState<PracticeTarget | null>(null);
  const clearPractice = useCallback(() => setPractice(null), []);

  function startPractice(t: PracticeTarget) {
    setPractice(t);
    setTab("puzzles");
  }

  const reload = useCallback(() => {
    training
      .stats()
      .then(setStats)
      .catch((e) => setLoadError(String(e)));
    training
      .latestInsight()
      .then(setInsight)
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function openMistakeById(id: number) {
    setSelected(await training.mistake(id));
  }

  return (
    <Stack p="md" h="100%">
      <Title order={2}>Coach</Title>
      {loadError && <Alert color="red">{loadError}</Alert>}
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="drill">
            Drill{stats && stats.cardsDue > 0 ? ` (${stats.cardsDue})` : ""}
          </Tabs.Tab>
          <Tabs.Tab value="puzzles">Puzzles</Tabs.Tab>
          <Tabs.Tab value="mistakes">Mistakes</Tabs.Tab>
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
        </Tabs.List>
        <ScrollArea h="calc(100vh - 130px)" pt="md">
          <Tabs.Panel value="overview">
            <Overview
              stats={stats}
              insight={insight}
              reload={reload}
              openMistake={openMistakeById}
              onPractice={startPractice}
            />
          </Tabs.Panel>
          <Tabs.Panel value="puzzles">
            <CoachPuzzles insight={insight} initialTarget={practice} onTargetUsed={clearPractice} />
          </Tabs.Panel>
          <Tabs.Panel value="drill">
            <MistakeDrill onChange={reload} />
          </Tabs.Panel>
          <Tabs.Panel value="mistakes">
            <MistakeList openMistake={setSelected} />
          </Tabs.Panel>
          <Tabs.Panel value="settings">
            <CoachSettings />
          </Tabs.Panel>
        </ScrollArea>
      </Tabs>
      <MistakeDetail mistake={selected} onClose={() => setSelected(null)} />
    </Stack>
  );
}
