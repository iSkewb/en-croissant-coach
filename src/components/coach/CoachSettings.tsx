import {
  Button,
  Card,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { enginesAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { type CoachSettingsView, coachIngestSettingsAtom, training } from "@/utils/training";

export default function CoachSettings() {
  const [ingest, setIngest] = useAtom(coachIngestSettingsAtom);
  const engines = useAtomValue(enginesAtom);
  const local = useMemo(
    () => (engines ?? []).filter((e): e is LocalEngine => e.type === "local"),
    [engines],
  );

  const [view, setView] = useState<CoachSettingsView | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-5-5");
  const [every, setEvery] = useState(25);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    training.getSettings().then((v) => {
      setView(v);
      setModel(v.model);
      setEvery(v.autoInsightEvery);
    });
  }, []);

  async function save() {
    await training.setSettings(key ? key : null, model, every);
    setKey("");
    setView(await training.getSettings());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Stack maw={640}>
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
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={5}>AI coach</Title>
          <Text size="sm" c="dimmed">
            Explanations and pattern analysis use the Claude API. The key stays in the app's data
            folder (or set the ANTHROPIC_API_KEY environment variable instead) and is never shown to
            the interface.
          </Text>
          <PasswordInput
            label="Anthropic API key"
            placeholder={view?.hasApiKey ? "Saved (type to replace, or clear below)" : "sk-ant-..."}
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
          />
          <TextInput
            label="Model"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
          />
          <NumberInput
            label="Refresh pattern analysis after this many new mistakes"
            description="0 = only when you press the button"
            min={0}
            value={every}
            onChange={(v) => setEvery(Number(v) || 0)}
          />
          <Group>
            <Button onClick={save}>{saved ? "Saved" : "Save"}</Button>
            {view?.hasApiKey && (
              <Button
                variant="subtle"
                color="red"
                onClick={async () => {
                  await training.setSettings("", model, every);
                  setView(await training.getSettings());
                }}
              >
                Remove key
              </Button>
            )}
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
