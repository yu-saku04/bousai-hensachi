export type ScoreLevel = "safe" | "standard" | "caution" | "warning";
export type ScoreCategory = "physical" | "social" | "emotional";

export type ScoreKey =
  | "floodRisk"
  | "earthquakeRisk"
  | "fireRisk"
  | "agingRisk"
  | "shelterCapacity"
  | "isolationRisk"
  | "childcareStressRisk"
  | "emotionalRecoveryRisk"
  | "socialSupportScore"
  | "infrastructureRecoveryScore"
  | "familyDisasterPreparedness";

export interface ScoreItem {
  key: ScoreKey;
  weight: number;
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
  phase: 1 | 2 | 3;
  visible: boolean;
  category: ScoreCategory;
}

export const SCORE_ITEMS: ReadonlyArray<ScoreItem> = [
  {
    key: "floodRisk",
    weight: 0.15,
    label: "洪水リスク",
    shortLabel: "洪水",
    icon: "🌊",
    description: "河川氾濫・浸水への安全度",
    phase: 1,
    visible: true,
    category: "physical",
  },
  {
    key: "earthquakeRisk",
    weight: 0.15,
    label: "地震リスク",
    shortLabel: "地震",
    icon: "🏔️",
    description: "地震・液状化への安全度",
    phase: 1,
    visible: true,
    category: "physical",
  },
  {
    key: "fireRisk",
    weight: 0.12,
    label: "火災リスク",
    shortLabel: "火災",
    icon: "🔥",
    description: "火災発生・延焼への安全度",
    phase: 1,
    visible: true,
    category: "physical",
  },
  {
    key: "agingRisk",
    weight: 0.10,
    label: "高齢化リスク",
    shortLabel: "高齢化",
    icon: "👥",
    description: "高齢化による避難困難度への余裕度",
    phase: 1,
    visible: true,
    category: "social",
  },
  {
    key: "shelterCapacity",
    weight: 0.10,
    label: "避難所余裕度",
    shortLabel: "避難所",
    icon: "🏠",
    description: "避難所の収容余裕・整備状況",
    phase: 1,
    visible: true,
    category: "social",
  },
  {
    key: "socialSupportScore",
    weight: 0.10,
    label: "社会支援力",
    shortLabel: "社会支援",
    icon: "🤝",
    description: "地域コミュニティ・行政支援の充実度",
    phase: 3,
    visible: true,
    category: "social",
  },
  {
    key: "infrastructureRecoveryScore",
    weight: 0.10,
    label: "インフラ回復力",
    shortLabel: "インフラ",
    icon: "🔧",
    description: "道路・電力・通信インフラの復旧能力",
    phase: 3,
    visible: true,
    category: "social",
  },
  {
    key: "isolationRisk",
    weight: 0.07,
    label: "孤立リスク",
    shortLabel: "孤立",
    icon: "🔗",
    description: "災害時の地域孤立・交通遮断への耐性",
    phase: 3,
    visible: true,
    category: "emotional",
  },
  {
    key: "childcareStressRisk",
    weight: 0.05,
    label: "子育てストレスリスク",
    shortLabel: "子育て",
    icon: "👶",
    description: "子育て世帯の避難困難・ストレス負荷",
    phase: 3,
    visible: true,
    category: "emotional",
  },
  {
    key: "emotionalRecoveryRisk",
    weight: 0.05,
    label: "感情回復力",
    shortLabel: "感情回復",
    icon: "💚",
    description: "被災後の精神的・感情的な立ち直り力",
    phase: 3,
    visible: true,
    category: "emotional",
  },
  {
    key: "familyDisasterPreparedness",
    weight: 0.01,
    label: "家族防災力",
    shortLabel: "家族防災",
    icon: "👨‍👩‍👧",
    description: "家族単位での防災意識・備え・連携度",
    phase: 3,
    visible: true,
    category: "emotional",
  },
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

export function calcCategoryScore(
  scores: Partial<Record<ScoreKey, number>>,
  category: ScoreCategory
): number | null {
  const items = SCORE_ITEMS.filter((i) => i.visible && i.category === category);
  let total = 0;
  let count = 0;
  for (const { key } of items) {
    const val = scores[key];
    if (typeof val === "number" && !isNaN(val)) {
      total += clampScore(val);
      count++;
    }
  }
  if (count === 0) return null;
  return Math.round(total / count);
}

export const CATEGORY_LABELS: Record<ScoreCategory, string> = {
  physical: "物理的安全",
  social: "社会回復力",
  emotional: "感情回復力",
};

export const CATEGORY_ICONS: Record<ScoreCategory, string> = {
  physical: "🏗️",
  social: "🤝",
  emotional: "💚",
};

export const CATEGORY_COLORS: Record<ScoreCategory, string> = {
  physical: "#3b82f6",
  social: "#10b981",
  emotional: "#a855f7",
};
