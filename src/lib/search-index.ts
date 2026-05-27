import rawIndex from "@/data/municipality-search-index.json";

export interface MunicipalityIndex {
  id: string;
  jisCode: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
}

const index = rawIndex as MunicipalityIndex[];

export function searchByKeyword(keyword: string, limit = 20): MunicipalityIndex[] {
  const kw = keyword.trim().slice(0, 50);
  if (!kw) return [];
  return index
    .filter((m) => m.municipality.includes(kw) || m.prefecture.includes(kw))
    .slice(0, limit);
}

export function getAllFromIndex(): MunicipalityIndex[] {
  return index;
}

export function getAllPrefecturesFromIndex(): string[] {
  return Array.from(new Set(index.map((m) => m.prefecture))).sort();
}

export function getMunicipalitiesByPrefectureFromIndex(prefecture: string): MunicipalityIndex[] {
  return index.filter((m) => m.prefecture === prefecture);
}

export function buildResultPath(jisCode: string): string {
  return `/result/${encodeURIComponent(jisCode)}`;
}
