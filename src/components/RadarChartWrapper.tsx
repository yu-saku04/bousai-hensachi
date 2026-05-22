"use client";

import dynamic from "next/dynamic";
import type { Municipality } from "@/types/municipality";

const DisasterRadarChart = dynamic(
  () => import("@/components/DisasterRadarChart"),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 flex items-center justify-center text-xs text-gray-400">
        チャートを読み込み中...
      </div>
    ),
  }
);

interface Props {
  municipality: Municipality;
}

export default function RadarChartWrapper({ municipality }: Props) {
  return <DisasterRadarChart municipality={municipality} />;
}
