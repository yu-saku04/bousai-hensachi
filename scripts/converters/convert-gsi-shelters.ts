/**
 * GSI designated emergency evacuation site / shelter CSV converter.
 *
 * Converts a local GSI CSV into the project standard:
 *   data/raw/national/shelters.csv
 *
 * The GSI national CSV has "都道府県名及び市町村名" but not a JIS code.
 * This converter resolves jisCode by matching prefecture + municipality
 * against data/master/municipalities-base.json.
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const DEFAULT_INPUT = "data/raw/gsi/shelters.csv";
const DEFAULT_OUTPUT = "data/raw/national/shelters.csv";
const DEFAULT_MASTER = "data/master/municipalities-base.json";
const DEFAULT_SOURCE_URL = "https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html";
const URL_RE = /^https?:\/\/.+/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const OUTPUT_COLUMNS = [
  "jisCode",
  "prefecture",
  "municipality",
  "shelterName",
  "address",
  "latitude",
  "longitude",
  "capacity",
  "disasterTypes",
  "sourceUrl",
  "updatedAt",
] as const;

const DISASTER_COLUMN_MAP: Array<{ column: string; type: string }> = [
  { column: "洪水", type: "flood" },
  { column: "崖崩れ、土石流及び地滑り", type: "landslide" },
  { column: "高潮", type: "storm" },
  { column: "地震", type: "earthquake" },
  { column: "津波", type: "tsunami" },
  { column: "大規模な火事", type: "fire" },
  { column: "内水氾濫", type: "inland_flood" },
  { column: "火山現象", type: "volcano" },
];

interface MunicipalityMaster {
  jisCode: string;
  prefecture: string;
  municipality: string;
}

interface StandardShelterRow {
  jisCode: string;
  prefecture: string;
  municipality: string;
  shelterName: string;
  address: string;
  latitude: string;
  longitude: string;
  capacity: string;
  disasterTypes: string;
  sourceUrl: string;
  updatedAt: string;
}

interface ResolvedMunicipality {
  jisCode: string;
  prefecture: string;
  municipality: string;
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function todayJst(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function readCsv(filePath: string): Array<Record<string, string>> {
  const content = fs.readFileSync(filePath, "utf-8");
  return parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>;
}

function readMaster(filePath: string): MunicipalityMaster[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as MunicipalityMaster[];
  return raw.filter(
    (m) =>
      typeof m.jisCode === "string" &&
      typeof m.prefecture === "string" &&
      typeof m.municipality === "string",
  );
}

function buildMasterLookup(master: MunicipalityMaster[]): Map<string, MunicipalityMaster> {
  const lookup = new Map<string, MunicipalityMaster>();
  for (const m of master) {
    lookup.set(normalizeText(`${m.prefecture}${m.municipality}`), m);
    lookup.set(normalizeText(`${m.prefecture}_${m.municipality}`), m);
  }
  return lookup;
}

function pick(row: Record<string, string>, candidates: string[]): string {
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function splitAddress(address: string): { prefecture: string; municipality: string } | null {
  const parts = address
    .split(/[／/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return { prefecture: parts[0], municipality: parts[1] };
  }
  return null;
}

function resolveMunicipality(
  row: Record<string, string>,
  lookup: Map<string, MunicipalityMaster>,
): ResolvedMunicipality | null {
  const combined = pick(row, [
    "都道府県名及び市町村名",
    "都道府県名および市町村名",
    "都道府県市町村名",
    "自治体名",
  ]);
  const prefecture = pick(row, ["都道府県名", "都道府県", "prefecture"]);
  const municipality = pick(row, ["市町村名", "市区町村名", "市区町村", "municipality"]);
  const address = pick(row, ["住所", "所在地", "address"]);

  const candidates: string[] = [];
  if (combined) candidates.push(combined);
  if (prefecture && municipality) candidates.push(`${prefecture}${municipality}`);

  const addressParts = splitAddress(address);
  if (addressParts) {
    candidates.push(`${addressParts.prefecture}${addressParts.municipality}`);
  }

  for (const candidate of candidates) {
    const found = lookup.get(normalizeText(candidate));
    if (found) {
      return {
        jisCode: found.jisCode,
        prefecture: found.prefecture,
        municipality: found.municipality,
      };
    }
  }

  return null;
}

function isMarked(value: string | undefined): boolean {
  const normalized = (value ?? "").trim();
  return normalized === "1" || normalized === "○" || normalized === "〇" || normalized.toLowerCase() === "true";
}

function buildDisasterTypes(row: Record<string, string>): string {
  const disasterTypes = DISASTER_COLUMN_MAP
    .filter(({ column }) => isMarked(row[column]))
    .map(({ type }) => type);
  return disasterTypes.length > 0 ? disasterTypes.join("|") : "unknown";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function writeStandardCsv(rows: StandardShelterRow[], outputPath: string): void {
  const lines = [
    OUTPUT_COLUMNS.join(","),
    ...rows.map((row) =>
      OUTPUT_COLUMNS.map((column) => csvEscape(String(row[column] ?? ""))).join(","),
    ),
  ];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf-8");
}

function convertGsiShelters(
  inputPath: string,
  outputPath: string,
  masterPath: string,
  sourceUrl: string,
  updatedAt: string,
): void {
  if (!URL_RE.test(sourceUrl)) {
    throw new Error(`--source-url は http(s) URL である必要があります: ${sourceUrl}`);
  }
  if (!DATE_RE.test(updatedAt)) {
    throw new Error(`--updated-at は YYYY-MM-DD 形式である必要があります: ${updatedAt}`);
  }
  if (!fs.existsSync(inputPath)) throw new Error(`入力CSVが見つかりません: ${inputPath}`);
  if (!fs.existsSync(masterPath)) throw new Error(`master JSONが見つかりません: ${masterPath}`);

  const rows = readCsv(inputPath);
  if (rows.length === 0) throw new Error("入力CSVが空です");

  const master = readMaster(masterPath);
  const lookup = buildMasterLookup(master);
  const converted: StandardShelterRow[] = [];
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const municipality = resolveMunicipality(row, lookup);
    if (!municipality) {
      const rawName = pick(row, ["都道府県名及び市町村名", "住所", "所在地"]);
      errors.push(`行${rowNumber}: 自治体をmasterから解決できません (${rawName || "自治体名/住所なし"})`);
      return;
    }

    const shelterName = pick(row, ["施設・場所名", "施設名", "場所名", "名称", "shelterName"]);
    if (!shelterName) {
      errors.push(`行${rowNumber}: 施設・場所名が空です`);
      return;
    }

    converted.push({
      jisCode: municipality.jisCode,
      prefecture: municipality.prefecture,
      municipality: municipality.municipality,
      shelterName,
      address: pick(row, ["住所", "所在地", "address"]),
      latitude: pick(row, ["緯度", "latitude", "lat"]),
      longitude: pick(row, ["経度", "longitude", "lon", "lng"]),
      capacity: pick(row, ["収容人数", "収容可能人数", "capacity"]),
      disasterTypes: buildDisasterTypes(row),
      sourceUrl,
      updatedAt,
    });
  });

  if (errors.length > 0) {
    console.error(`変換エラー (${errors.length}件):`);
    for (const error of errors.slice(0, 50)) console.error(`  ${error}`);
    if (errors.length > 50) console.error(`  ...ほか ${errors.length - 50}件`);
    throw new Error("GSI CSVの変換に失敗しました");
  }

  writeStandardCsv(converted, outputPath);
  const municipalityCount = new Set(converted.map((row) => row.jisCode)).size;
  const unknownCount = converted.filter((row) => row.disasterTypes === "unknown").length;

  console.log(`入力: ${inputPath}`);
  console.log(`出力: ${outputPath}`);
  console.log(`変換件数: ${converted.length}施設 / ${municipalityCount}自治体`);
  console.log(`disasterTypes=unknown: ${unknownCount}件`);
}

if (require.main === module) {
  const inputPath = getArg("--input") ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;
  const masterPath = getArg("--master") ?? DEFAULT_MASTER;
  const sourceUrl = getArg("--source-url") ?? DEFAULT_SOURCE_URL;
  const updatedAt = getArg("--updated-at") ?? todayJst();

  try {
    convertGsiShelters(inputPath, outputPath, masterPath, sourceUrl, updatedAt);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
