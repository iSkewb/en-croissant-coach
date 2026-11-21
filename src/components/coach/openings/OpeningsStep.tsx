// The lesson's openings step: set up a repertoire once, then a short review each lesson.
import { Loader } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { type RepCard, type RepLine, training } from "@/utils/training";
import OpeningReview from "./OpeningReview";
import { StarterPicker } from "./OpeningsPage";
import { parseLine, planSession } from "./repertoire";

export default function OpeningsStep({
  date,
  size,
  onDone,
}: {
  date: string;
  size: number;
  onDone: () => void;
}) {
  const [data, setData] = useState<{ lines: RepLine[]; cards: RepCard[] } | null>(null);
  const load = useCallback(() => {
    Promise.all([training.repLines(), training.repCards()])
      .then(([lines, cards]) => setData({ lines, cards }))
      .catch(() => setData({ lines: [], cards: [] }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <Loader />;
  if (data.lines.length === 0) return <StarterPicker onDone={load} />;
  const session = planSession(data.lines.map(parseLine), data.cards, new Date(), {
    maxPositions: size,
    maxNew: Math.min(4, size),
  });
  return (
    <OpeningReview
      session={session}
      cards={data.cards}
      finishLabel="Back to lesson"
      onFinished={async () => {
        await training.setMark(date, "openings", true).catch(() => {});
        onDone();
      }}
    />
  );
}
