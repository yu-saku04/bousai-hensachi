"use client";

import dynamic from "next/dynamic";
import type { RadarDataPoint } from "@/components/DisasterRadarChart";

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
  data: RadarDataPoint[];
}

export default function RadarChartWrapper({ data }: Props) {
  return <DisasterRadarChart data={data} />;
}
