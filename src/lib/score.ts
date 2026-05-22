// ScoreLevel を score.ts に集約（types/municipality.ts からの循環依存を解消）
export type ScoreLevel = "safe" | "standard" | "caution" | "warning";

// スコア対象キー
export type ScoreKey =
  | "floodRisk"
  | "earthquakeRisk"
  | "fireRisk"
  | "agingRisk"
  | "shelterCapacity";

export interface ScoreItem {
  key: ScoreKey;
  weight: number;
  label: string;
  icon: string;
  description: string;
  phase: 1 | 2 | 3;
  visible: boolean;
}

// Phase1 の5指数を定義。Phase3指数追加時はここに追記し visible:true にするだけ。
export const SCORE_ITEMS: ReadonlyArray<ScoreItem> = [
  {
    key: "floodRisk",
    weight: 0.25,
    label: "洪水リスク",
    icon: "🌊",
    description: "河川氾濫・浸水への安全度",
    phase: 1,
    visible: true,
  },
  {
    key: "earthquakeRisk",
    weight: 0.25,
    label: "地震リスク",
    icon: "🏔️",
    description: "地震・液状化への安全度",
    phase: 1,
    visible: true,
  },
  {
    key: "fireRisk",
    weight: 0.20,
    label: "火災リスク",
    icon: "🔥",
    description: "火災発生・延焼への安全度",
    phase: 1,
    visible: true,
  },
  {
    key: "agingRisk",
    weight: 0.15,
    label: "高齢化リスク",
    icon: "👥",
    description: "高齢化による避難困難度への余裕度",
    phase: 1,
    visible: true,
  },
  {
    key: "shelterCapacity",
    weight: 0.15,
    label: "避難所余裕度",
    icon: "🏠",
    description: "避難所の収容余裕・整備状況",
    phase: 1,
    visible: true,
  },
  // Phase3 指数: visible: false で追加待機中
  // { key: "isolationIndex",         weight: 0, label: "災害時孤立指数",   icon: "🔗", description: "交通・通信インフラの脆弱性", phase: 3, visible: false },
  // { key: "childcareDisasterIndex", weight: 0, label: "子育て防災指数",   icon: "👶", description: "子育て世帯の避難困難度",     phase: 3, visible: false },
];

export function getScoreLevel(score: number): ScoreLevel {
  if (score >= 70) return "safe";
  if (score >= 50) return "standard";
  if (score >= 30) return "caution";
  return "warning";
}

export function getScoreLevelLabel(score: number): string {
  const labels: Record<ScoreLevel, string> = {
    safe: "比較的安全",
    standard: "標準",
    caution: "注意",
    warning: "要警戒",
  };
  return labels[getScoreLevel(score)];
}

export function getScoreLevelColor(score: number): string {
  const colors: Record<ScoreLevel, string> = {
    safe: "text-emerald-600",
    standard: "text-blue-600",
    caution: "text-amber-500",
    warning: "text-red-600",
  };
  return colors[getScoreLevel(score)];
}

export function getScoreLevelBg(score: number): string {
  const bgs: Record<ScoreLevel, string> = {
    safe: "bg-emerald-50 border-emerald-200",
    standard: "bg-blue-50 border-blue-200",
    caution: "bg-amber-50 border-amber-200",
    warning: "bg-red-50 border-red-200",
  };
  return bgs[getScoreLevel(score)];
}

export function getScoreBarColor(score: number): string {
  const colors: Record<ScoreLevel, string> = {
    safe: "bg-emerald-500",
    standard: "bg-blue-500",
    caution: "bg-amber-400",
    warning: "bg-red-500",
  };
  return colors[getScoreLevel(score)];
}

export function clampScore(score: unknown): number {
  if (typeof score !== "number" || isNaN(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function calcOverallScore(
  scores: Partial<Record<ScoreKey, number>>
): number {
  let total = 0;
  let weightSum = 0;
  for (const { key, weight, visible } of SCORE_ITEMS) {
    if (!visible) continue;
    const val = scores[key];
    if (typeof val === "number" && !isNaN(val)) {
      total += clampScore(val) * weight;
      weightSum += weight;
    }
  }
  if (weightSum === 0) return 0;
  return Math.round(total / weightSum);
}
