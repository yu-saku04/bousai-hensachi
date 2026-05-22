"use client";

import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from "recharts";
import { SCORE_ITEMS, clampScore } from "@/lib/score";
import type { Municipality } from "@/types/municipality";

interface Props {
  municipality: Municipality;
}

export default function DisasterRadarChart({ municipality }: Props) {
  const data = SCORE_ITEMS.filter((item) => item.visible).map((item) => {
    const raw = municipality[item.key as keyof Municipality];
    return {
      subject: item.shortLabel,
      score: clampScore(typeof raw === "number" ? raw : 0),
      fullMark: 100,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={260}>
      <RadarChart cx="50%" cy="50%" outerRadius="75%" data={data}>
        <PolarGrid stroke="#e5e7eb" />
        <PolarAngleAxis
          dataKey="subject"
          tick={{ fontSize: 10, fill: "#6b7280" }}
        />
        <Radar
          name="スコア"
          dataKey="score"
          stroke="#3b82f6"
          fill="#3b82f6"
          fillOpacity={0.3}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}
