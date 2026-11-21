import {
  Alert,
  Button,
  Card,
  Chip,
  Code,
  Group,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { enginesAtom } from "@/state/atoms";
import { type LessonLength, type Weekday, WEEKDAY_NAMES } from "./lesson/lessonPlan";
import { lessonPrefsAtom } from "./lesson/settings";
import type { LocalEngine } from "@/utils/engines";
import {
  type CoachProvider,
  type CoachSettingsView,
  coachIngestSettingsAtom,
  training,
} from "@/utils/training";

const CC_MODELS = [
  { value: "haiku", label: "Haiku (lightest on your plan)" },
  { value: "sonnet", label: "Sonnet (balanced)" },
  { value: "opus", label: "Opus (heaviest)" },
];

const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

function LessonSettingsCard() {
  const [prefs, setPrefs] = useAtom(lessonPrefsAtom);
  return (
    <Card withBorder>
      <Stack>
        <Title order={5}>Lessons</Title>
        <TextInput
          label="What should the coach call you?"
          placeholder="Your first name"
          value={prefs.name}
          onChange={(e) => setPrefs({ ...prefs, name: e.currentTarget.value })}
        />
        <div>
          <Text size="sm" fw={500} mb={4}>
            Training days
          </Text>
          <Chip.Group
            multiple
            value={prefs.trainingDays.map(String)}
            onChange={(v) =>
              setPrefs({ ...prefs, trainingDays: v.map((d) => Number(d) as Weekday).sort() })
            }
          >
            <Group gap={6}>
              {WEEK_ORDER.map((d) => (
                <Chip key={d} value={String(d)} size="sm">
                  {WEEKDAY_NAMES[d].slice(0, 3)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Text size="xs" c="dimmed" mt={4}>
            The weekly check-in happens on your last training day of the week.
          </Text>
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Lesson length
          </Text>
          <SegmentedControl
            value={String(prefs.length)}
            onChange={(v) => setPrefs({ ...prefs, length: Number(v) as LessonLength })}
            data={[
              { value: "20", label: "20 min" },
              { value: "35", label: "35 min" },
              { value: "60", label: "60 min" },
            ]}
          />
        </div>
        <Switch
          label="Open the app on today's lesson"
          checked={prefs.openOnStart}
          onChange={(e) => setPrefs({ ...prefs, openOnStart: e.currentTarget.checked })}
        />
      </Stack>
    </Card>
  );
}

export default function CoachSettings() {
  const [ingest, setIngest] = useAtom(coachIngestSettingsAtom);
  const engines = useAtomValue(enginesAtom);
  const local = useMemo(
    () => (engines ?? []).filter((e): e is LocalEngine => e.type === "local"),
    [engines],
  );

  const [view, setView] = useState<CoachSettingsView | null>(null);
  const [provider, setProvider] = useState<CoachProvider>("claudeCode");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-5-5");
  const [claudePath, setClaudePath] = useState("");
  const [explainModel, setExplainModel] = useState("haiku");
  const [insightModel, setInsightModel] = useState("sonnet");
  const [every, setEvery] = useState(40);
  const [saved, setSaved] = useState(false);

  async function refresh() {
    const v = await training.getSettings();
    setView(v);
    setProvider(v.provider);
    setModel(v.model);
    setClaudePath(v.claudePath ?? "");
    setExplainModel(v.explainModel);
    setInsightModel(v.insightModel);
    setEvery(v.autoInsightEvery);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(apiKey: string | null = key ? key : null) {
    await training.setSettings({
      provider,
      apiKey,
      model,
      claudePath: claudePath.trim() || null,
      explainModel,
      insightModel,
      autoInsightEvery: every,
    });
    setKey("");
    await refresh();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const usage = view?.usage7d;

  return (
    <Stack maw={640}>
      <LessonSettingsCard />
      <Card withBorder>
        <Stack>
          <Title order={5}>Game analysis</Title>
          <Select
            label="Engine"
            data={local.map((e) => ({ value: e.id, label: e.name }))}
            value={ingest.engineId || local[0]?.id || null}
            onChange={(v) => setIngest({ ...ingest, engineId: v ?? "" })}
            placeholder="Install Stockfish on the Engines page"
          />
          <Group grow>
            <NumberInput
              label="Depth"
              description="14 ≈ a few seconds per game"
              min={8}
              max={24}
              value={ingest.depth}
              onChange={(v) => setIngest({ ...ingest, depth: Number(v) || 14 })}
            />
            <NumberInput
              label="Threads"
              min={1}
              max={64}
              value={ingest.threads}
              onChange={(v) => setIngest({ ...ingest, threads: Number(v) || 1 })}
            />
            <NumberInput
              label="Hash (MB)"
              min={16}
              max={4096}
              value={ingest.hashMb}
              onChange={(v) => setIngest({ ...ingest, hashMb: Number(v) || 128 })}
            />
          </Group>
          <NumberInput
            label="Max new games per run"
            description="Newest first. Leave empty for all."
            min={1}
            value={ingest.maxGames ?? ""}
            onChange={(v) => setIngest({ ...ingest, maxGames: v === "" ? null : Number(v) })}
          />
          <Switch
            label="Analyse automatically after downloading games"
            checked={ingest.autoAnalyze}
            onChange={(e) => setIngest({ ...ingest, autoAnalyze: e.currentTarget.checked })}
          />
          <Text size="xs" c="dimmed">
            Engine analysis runs on your computer and never uses your Claude plan.
          </Text>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={5}>AI coach</Title>
          <SegmentedControl
            value={provider}
            onChange={(v) => setProvider(v as CoachProvider)}
            data={[
              { value: "claudeCode", label: "Claude subscription (Claude Code)" },
              { value: "api", label: "API key (pay per use)" },
            ]}
          />

          {provider === "claudeCode" && (
            <>
              {view?.detectedClaudePath ? (
                <Alert color="green" icon={<IconCheck />} p="xs">
                  <Text size="sm">
                    Found Claude Code at <Code>{view.detectedClaudePath}</Code>
                  </Text>
                </Alert>
              ) : (
                <Alert
                  color="yellow"
                  icon={<IconAlertTriangle />}
                  p="xs"
                  title="Claude Code not found"
                >
                  <Text size="sm">
                    Install Claude Code from claude.com/claude-code, open it once and sign in with
                    your Claude account, then press Save here. Or enter the path to claude.exe
                    below.
                  </Text>
                </Alert>
              )}
              <TextInput
                label="Claude Code location (optional)"
                placeholder="Auto-detect"
                value={claudePath}
                onChange={(e) => setClaudePath(e.currentTarget.value)}
              />
              <Group grow>
                <Select
                  label="Model for explanations"
                  data={CC_MODELS}
                  value={explainModel}
                  onChange={(v) => setExplainModel(v ?? "haiku")}
                  allowDeselect={false}
                />
                <Select
                  label="Model for pattern analysis"
                  data={CC_MODELS}
                  value={insightModel}
                  onChange={(v) => setInsightModel(v ?? "sonnet")}
                  allowDeselect={false}
                />
              </Group>
              <Text size="xs" c="dimmed">
                Each request is sent with no tools, no extra context and low effort to use as little
                of your plan as possible. Explanations are saved, so each mistake is only explained
                once.
              </Text>
            </>
          )}

          {provider === "api" && (
            <>
              <Text size="sm" c="dimmed">
                Billed per use on your Anthropic Console account. The key stays in the app's data
                folder (or set ANTHROPIC_API_KEY) and is never shown to the interface.
              </Text>
              <PasswordInput
                label="Anthropic API key"
                placeholder={view?.hasApiKey ? "Saved (type to replace)" : "sk-ant-..."}
                value={key}
                onChange={(e) => setKey(e.currentTarget.value)}
              />
              <TextInput
                label="Model"
                value={model}
                onChange={(e) => setModel(e.currentTarget.value)}
              />
            </>
          )}

          <NumberInput
            label="Refresh pattern analysis after this many new mistakes"
            description="0 = only when you press the button. Higher = less usage."
            min={0}
            value={every}
            onChange={(v) => setEvery(Number(v) || 0)}
          />
          {usage && (
            <Text size="xs" c="dimmed">
              Last 7 days: {usage.calls} AI request{usage.calls === 1 ? "" : "s"},{" "}
              {(usage.inputTokens / 1000).toFixed(1)}k tokens in /{" "}
              {(usage.outputTokens / 1000).toFixed(1)}k out
            </Text>
          )}
          <Group>
            <Button onClick={() => save()}>{saved ? "Saved" : "Save"}</Button>
            {provider === "api" && view?.hasApiKey && (
              <Button variant="subtle" color="red" onClick={() => save("")}>
                Remove key
              </Button>
            )}
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
