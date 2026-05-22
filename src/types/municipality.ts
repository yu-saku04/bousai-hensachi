import { SCORE_ITEMS } from "@/lib/score";
import type { ScoreKey } from "@/lib/score";

// ScoreLevel は lib/score.ts に移動（score.ts → municipality.ts の循環依存を解消）
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
  // Phase2拡張用フィールド（optional）
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  population?: number;
  agingRate?: number;
  floodSource?: string;
  earthquakeSource?: string;
  fireSource?: string;
  shelterSource?: string;
  dataUpdatedAt?: string;
  updatedAt?: string;
  // Phase3拡張用フィールド（optional）
  isolationIndex?: number;
  childcareDisasterIndex?: number;
  emotionalResilienceIndex?: number;
  familyDisasterIndex?: number;
  postDisasterLivingRisk?: number;
  aiComment?: string;
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

// SCORE_ITEMS から visible な項目のみ派生。Phase3指数追加時は SCORE_ITEMS に追記するだけ
export const RISK_ITEMS: ReadonlyArray<RiskItem> = SCORE_ITEMS
  .filter((item) => item.visible)
  .map(({ key, label, icon, description }) => ({ key, label, icon, description }));
