import "server-only";
import type { Municipality } from "@/types/municipality";
import type { ScoreCategory, ScoreKey } from "@/lib/score";
import { calcCategoryScore } from "@/lib/score";
import rawData from "@/data/municipalities.json";

const data = rawData as Municipality[];

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function getAllMunicipalities(): Municipality[] {
  return data;
}

export function getMunicipalityByParams(
  prefecture: string,
  municipality: string
): Municipality | null {
  const decodedPref = safeDecode(prefecture);
  const decodedMuni = safeDecode(municipality);
  const found = data.find(
    (m) => m.prefecture === decodedPref && m.municipality === decodedMuni
  );
  return found ?? null;
}

export function getMunicipalityById(id: string): Municipality | null {
  return data.find((m) => m.id === id) ?? null;
}

export function getAllPrefectures(): string[] {
  return Array.from(new Set(data.map((m) => m.prefecture))).sort();
}

export function getMunicipalitiesByPrefecture(prefecture: string): Municipality[] {
  return data.filter((m) => m.prefecture === prefecture);
}

export function getRanking(): Municipality[] {
  return [...data].sort((a, b) => b.overallScore - a.overallScore);
}

export function getPrefectureRanking(prefecture: string): Municipality[] {
  return getMunicipalitiesByPrefecture(prefecture).sort(
    (a, b) => b.overallScore - a.overallScore
  );
}

export function getCategoryRanking(category: ScoreCategory): Municipality[] {
  return [...data]
    .map((m) => ({
      m,
      score: calcCategoryScore(m as Partial<Record<ScoreKey, number>>, category) ?? 0,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ m }) => m);
}

export function buildResultPath(prefecture: string, municipality: string): string {
  return `/result/${encodeURIComponent(prefecture)}/${encodeURIComponent(municipality)}`;
}

export function searchMunicipalities(keyword: string): Municipality[] {
  const kw = keyword.trim();
  if (!kw) return [];
  return data.filter(
    (m) => m.municipality.includes(kw) || m.prefecture.includes(kw)
  );
}
