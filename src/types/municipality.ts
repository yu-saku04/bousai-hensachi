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
  // shelter-sufficiency-v1
  shelterCount?: number | null;
  shelterCountPer10k?: number | null;
  shelterScore?: number | null;
  nationalRank?: number | null;
  prefectureRank?: number | null;
  dataCompleteness?: { hasPopulation: boolean; hasShelterData: boolean };
  scoreConfidence?: "high" | "no-shelter-data" | "no-data";
  scoreVersion?: "shelter-sufficiency-v1";
  calculationNotes?: string;
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
