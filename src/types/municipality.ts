import { SCORE_ITEMS } from "@/lib/score";
import type { ScoreKey } from "@/lib/score";

export type { ScoreLevel } from "@/lib/score";

export interface Municipality {
  id: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
  floodRisk: number;
  earthquakeRisk: number;
  fireRisk: number;
  agingRisk: number;
  shelterCapacity: number;
  comment: string;
  actionTips: string[];
  sourceNote: string;
  /** 市区町村JISコード（5桁数字文字列）。全国実データ投入での第一結合キー。 */
  jisCode: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  population?: number;
  agingRate?: number;
  elderlyPopulation?: number;
  agingSource?: string;
  agingUpdatedAt?: string;
  floodSource?: string;
  earthquakeSource?: string;
  fireSource?: string;
  shelterSource?: string;
  dataUpdatedAt?: string;
  updatedAt?: string;
  // Phase3フィールド
  isolationRisk?: number;
  childcareStressRisk?: number;
  emotionalRecoveryRisk?: number;
  socialSupportScore?: number;
  infrastructureRecoveryScore?: number;
  familyDisasterPreparedness?: number;
  // household-v1
  totalGeneralHouseholds?: number;
  elderlySingleHouseholds?: number;
  elderlyCoupleHouseholds?: number;
  elderlySingleRate?: number;
  elderlyCoupleRate?: number;
  householdRisk?: number;
  householdSource?: string;
  householdUpdatedAt?: string;
  // shelter-sufficiency-v1
  shelterCount?: number | null;
  shelterCountPer10k?: number | null;
  shelterScore?: number | null;
  nationalRank?: number | null;
  prefectureRank?: number | null;
  dataCompleteness?: { hasPopulation: boolean; hasShelterData: boolean };
  scoreVersion?: "shelter-sufficiency-v1";
  calculationNotes?: string;
  // earthquake-v1
  earthquakeProbability?: number | null;
  earthquakePex?: number | null;
  earthquakeScore?: number | null;
  earthquakeRank?: number | null;
  earthquakeVersion?: "Y2020";
  earthquakeDataStatus?: "direct" | "aggregated-from-wards" | "known-missing" | "not-found";
  earthquakeProbabilityMethod?: "direct" | "ward-average" | "neutral-fallback";
  earthquakeSourceJisCodes?: string[] | null;
  earthquakeProbabilityMin?: number | null;
  earthquakeProbabilityMax?: number | null;
  earthquakeWardCount?: number | null;
  earthquakeUpdatedAt?: string;
  // flood-v1
  floodRiskCandidate?: number | null;
  floodDataStatus?: "scored" | "no-flood-data" | "ward-averaged" | "missing";
  maxDepthCode?: number | null;
  maxDepthDanger?: number | null;
  floodAreaRatio?: number | null;
  floodUpdatedAt?: string;
  // landslide-v1
  landslideRiskCandidate?: number | null;
  landslideDataStatus?: "scored" | "no-landslide-data" | "ward-averaged" | "missing";
  landslideAreaRatio?: number | null;
  landslideSpecialAreaRatio?: number | null;
  landslideSource?: string;
  landslideUpdatedAt?: string;
  // tsunami-v1
  tsunamiRiskCandidate?: number | null;
  tsunamiDataStatus?: "scored" | "no-tsunami-data" | "no-tsunami-risk" | "ward-averaged" | "missing";
  tsunamiAreaRatio?: number | null;
  tsunamiMaxDepthM?: number | null;
  tsunamiSource?: string;
  tsunamiUpdatedAt?: string;
  // storm-surge-v1
  stormSurgeRiskCandidate?: number | null;
  stormSurgeDataStatus?: "scored" | "no-storm-surge-data" | "no-storm-surge-risk" | "ward-averaged" | "missing";
  stormSurgeAreaRatio?: number | null;
  stormSurgeMaxDepthM?: number | null;
  stormSurgeSource?: string;
  stormSurgeUpdatedAt?: string;
  // liquefaction-v1 (地形由来の液状化発生傾向)
  liquefactionRiskCandidate?: number | null;
  liquefactionDataStatus?: "scored" | "no-liquefaction-risk" | "no-liquefaction-area" | "ward-averaged" | "missing";
  liquefactionSusceptibleAreaRatio?: number | null;
  liquefactionHighRiskAreaRatio?: number | null;
  liquefactionMaxRiskClass?: string | null;
  liquefactionSource?: string;
  liquefactionMethod?: string;
  liquefactionUpdatedAt?: string;
  // overallScoreV2 (v2.5 = earthquake + flood + landslide + tsunami + storm surge + liquefaction)
  overallScoreV2?: number | null;
  overallScoreV2Version?: string;
  hazardCoverageCount: number;
  hazardCoverageRate: number;
  scoreConfidence: "high" | "medium-high" | "medium" | "low";
}

export interface RiskItem {
  key: ScoreKey;
  label: string;
  description: string;
  icon: string;
}

export interface SearchParams {
  prefecture: string;
  municipality: string;
}

export const RISK_ITEMS: ReadonlyArray<RiskItem> = SCORE_ITEMS
  .filter((item) => item.visible)
  .map(({ key, label, icon, description }) => ({ key, label, icon, description }));
