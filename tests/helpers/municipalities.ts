import fs from "fs";
import path from "path";

interface MunicipalityRecord {
  jisCode: string;
  municipality: string;
  prefecture: string;
  overallScore: number;
  overallScoreV2?: number | null;
  hazardCoverageCount?: number;
  scoreConfidence?: "high" | "medium-high" | "medium" | "low";
}

const dataPath = path.resolve(__dirname, "../../src/data/municipalities.json");
const rawData: MunicipalityRecord[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
const byJisCode = new Map(rawData.map((m) => [m.jisCode, m]));

/** src/lib/score.ts の clampScore と同一ロジック */
export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function getMunicipality(jisCode: string): MunicipalityRecord {
  const m = byJisCode.get(jisCode);
  if (!m) throw new Error(`municipalities.json に jisCode=${jisCode} が存在しません`);
  return m;
}

export function getMunicipalityByHazardCoverage(count: number): MunicipalityRecord {
  const m = rawData.find((entry) => entry.hazardCoverageCount === count);
  if (!m) throw new Error(`hazardCoverageCount=${count} の自治体が存在しません`);
  return m;
}

/**
 * overallScoreV2 ?? overallScore に clampScore を適用した表示スコアを返す。
 * 両方 null/undefined の場合はエラー。
 */
export function getExpectedScore(jisCode: string): number {
  const m = getMunicipality(jisCode);
  const raw = m.overallScoreV2 ?? m.overallScore;
  if (raw == null || !Number.isFinite(raw)) {
    throw new Error(`jisCode=${jisCode} のスコアが null/undefined です`);
  }
  return clampScore(raw);
}

/** スコアテキストを数値に変換する（先頭末尾スペース除去・単位なし数値のみ許容）*/
export function normalizeScoreText(text: string): number {
  const trimmed = text.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(`スコアテキストを数値に変換できません: "${trimmed}"`);
  }
  return n;
}

/** 横スクロール判定（mobile.spec.ts でも共用できる） */
export async function checkNoHorizontalScroll(
  page: import("@playwright/test").Page
): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}
