import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getMunicipalityByJisCode, getAllMunicipalities, buildResultPath } from "@/lib/municipalities";
import { safeJsonLd } from "@/lib/json-ld";
import {
  getScoreLevelLabel,
  clampScore,
  calcCategoryScore,
  getScoreLevelColor,
} from "@/lib/score";
import type { ScoreCategory, ScoreKey } from "@/lib/score";
import ScoreCard from "@/components/ScoreCard";
import ShareButtons from "@/components/ShareButtons";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import type { Municipality } from "@/types/municipality";

export const dynamicParams = false;

interface PageProps {
  params: Promise<{ jisCode: string }>;
}

const JIS_CODE_RE = /^[0-9]{5}$/;

export async function generateStaticParams() {
  return getAllMunicipalities()
    .filter((m) => {
      if (!JIS_CODE_RE.test(m.jisCode)) {
        console.warn(`result SSG: 不正jisCodeのエントリを除外 (id=${m.id}, jisCode=${m.jisCode})`);
        return false;
      }
      return true;
    })
    .map((m) => ({ jisCode: m.jisCode }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { jisCode } = await params;
  const data = getMunicipalityByJisCode(jisCode);
  if (!data) return { title: "データが見つかりません | 全国防災偏差値" };
  if (!data.jisCode) return { title: "データが見つかりません | 全国防災偏差値" };

  const SITE_URL = "https://bousai-hensachi.vercel.app";
  const metaScore = data.overallScoreV2 ?? data.overallScore;
  const title = `${data.prefecture}${data.municipality}の防災偏差値 ${metaScore}`;
  const description = data.comment;
  const url = `${SITE_URL}${buildResultPath(data.jisCode)}`;

  return {
    title: `${title} | 全国防災偏差値`,
    description,
    openGraph: {
      title,
      description,
      url,
      type: "article",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}


function buildRuleBasedComment(data: Municipality): string {
  const scores = data as Partial<Record<ScoreKey, number>>;
  const physicalScore = calcCategoryScore(scores, "physical") ?? 0;
  const socialScore = calcCategoryScore(scores, "social") ?? 0;
  const emotionalScore = calcCategoryScore(scores, "emotional") ?? 0;

  const weakest = physicalScore <= socialScore && physicalScore <= emotionalScore
    ? "physical"
    : socialScore <= emotionalScore
    ? "social"
    : "emotional";

  const weakMessages: Record<ScoreCategory, string> = {
    physical: "自然災害リスクへの物理的備えを強化することが優先課題です。",
    social: "地域の助け合い体制やインフラ回復力の向上が重要な課題です。",
    emotional: "孤立防止・心のケア・家族防災力の強化が今後の重点テーマです。",
  };

  const overall = data.overallScoreV2 ?? data.overallScore;
  if (overall >= 70) {
    return `防災体制が全体的に整った地域です。${weakMessages[weakest]}`;
  }
  if (overall >= 50) {
    return `平均的な防災水準の地域です。${weakMessages[weakest]}`;
  }
  if (overall >= 30) {
    return `いくつかの重要リスクへの対策強化が必要です。${weakMessages[weakest]}`;
  }
  return `複数の重大リスクが存在します。早急な防災行動計画の策定を推奨します。${weakMessages[weakest]}`;
}

function buildAiAdviceComment(data: Municipality): string {
  const sentences: string[] = [];

  if (typeof data.earthquakeRisk === "number" && clampScore(data.earthquakeRisk) >= 70) {
    sentences.push("地震リスクは比較的低いです。");
  }

  if (typeof data.floodRiskCandidate === "number" && clampScore(data.floodRiskCandidate) <= 40) {
    sentences.push("洪水への備えを優先してください。");
  }

  if (typeof data.landslideRiskCandidate === "number" && clampScore(data.landslideRiskCandidate) <= 40) {
    sentences.push("土砂災害への備えを優先してください。");
  }

  if (typeof data.tsunamiRiskCandidate === "number" && clampScore(data.tsunamiRiskCandidate) <= 40) {
    sentences.push("津波への備えを優先してください。");
  }

  if (typeof data.stormSurgeRiskCandidate === "number" && clampScore(data.stormSurgeRiskCandidate) <= 40) {
    sentences.push("高潮への備えを優先してください。");
  }

  if (typeof data.liquefactionRiskCandidate === "number" && clampScore(data.liquefactionRiskCandidate) <= 40) {
    sentences.push("地形由来の液状化発生傾向が高い地域です。地盤状況の確認を推奨します。");
  }

  const shelterVal =
    typeof data.shelterScore === "number"
      ? data.shelterScore
      : typeof data.shelterCapacity === "number"
      ? data.shelterCapacity
      : null;
  if (shelterVal !== null && clampScore(shelterVal) < 40) {
    sentences.push("避難所インフラに課題があります。");
  }

  if (typeof data.agingRisk === "number" && clampScore(data.agingRisk) < 40) {
    sentences.push("高齢化への支援体制が重要です。");
  }

  if (typeof data.householdRisk === "number" && clampScore(data.householdRisk) > 70) {
    sentences.push("地域コミュニティが比較的維持されています。");
  }

  return sentences.slice(0, 5).join("") || "現在のデータからアドバイスを生成できませんでした。";
}

function getLandslideStatusLabel(status: Municipality["landslideDataStatus"]): string {
  switch (status) {
    case "scored":
      return "土砂災害リスク算出済み";
    case "no-landslide-data":
      return "土砂災害警戒区域データなし";
    case "ward-averaged":
      return "行政区データから市全体を平均";
    case "missing":
      return "土砂データ未取得";
    default:
      return "未算出";
  }
}

function formatLandslideAreaRatio(value: Municipality["landslideAreaRatio"]): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "未算出";
}

function getTsunamiStatusLabel(status: Municipality["tsunamiDataStatus"]): string {
  switch (status) {
    case "scored":
      return "津波リスク算出済み";
    case "no-tsunami-data":
      return "津波浸水想定区域なし";
    case "no-tsunami-risk":
      return "内陸県（津波リスク対象外）";
    case "ward-averaged":
      return "行政区データから市全体を平均";
    case "missing":
      return "津波データ未算出";
    default:
      return "未算出";
  }
}

function formatTsunamiMaxDepth(
  status: Municipality["tsunamiDataStatus"],
  value: Municipality["tsunamiMaxDepthM"],
): string {
  if (status === "no-tsunami-data") return "該当なし";
  if (status === "no-tsunami-risk") return "対象外";
  if (status === "missing") return "未算出";
  if (status !== "scored" && status !== "ward-averaged") return "未算出";
  if (typeof value !== "number") return "未算出";
  return value > 0 ? `${value}m以上` : "0.3m未満";
}

function getStormSurgeStatusLabel(status: Municipality["stormSurgeDataStatus"]): string {
  switch (status) {
    case "scored":
      return "高潮浸水リスク算出済み";
    case "no-storm-surge-data":
      return "高潮浸水想定区域なし";
    case "no-storm-surge-risk":
      return "内陸県（高潮リスク対象外）";
    case "ward-averaged":
      return "行政区データから市全体を平均";
    case "missing":
      return "高潮データ未整備";
    default:
      return "未算出";
  }
}

function formatStormSurgeMaxDepth(
  status: Municipality["stormSurgeDataStatus"],
  value: Municipality["stormSurgeMaxDepthM"],
): string {
  if (status === "no-storm-surge-data") return "該当なし";
  if (status === "no-storm-surge-risk") return "対象外";
  if (status === "missing") return "未算出";
  if (status !== "scored" && status !== "ward-averaged") return "未算出";
  if (typeof value !== "number") return "未算出";
  return value > 0 ? `${value}m以上` : "0.3m未満";
}

function getLiquefactionStatusLabel(status: Municipality["liquefactionDataStatus"]): string {
  switch (status) {
    case "scored":
      return "液状化発生傾向算出済み";
    case "no-liquefaction-risk":
      return "液状化発生傾向なし（低リスク地形）";
    case "no-liquefaction-area":
      return "陸域メッシュなし";
    case "ward-averaged":
      return "行政区データから市全体を平均";
    case "missing":
      return "液状化データ未算出";
    default:
      return "未算出";
  }
}

function getFloodStatusLabel(status: Municipality["floodDataStatus"]): string {
  switch (status) {
    case "scored":
      return "洪水リスク算出済み";
    case "no-flood-data":
      return "洪水浸水想定区域データなし";
    case "ward-averaged":
      return "行政区データから市全体を平均";
    case "missing":
      return "洪水データ未取得";
    default:
      return "未算出";
  }
}

function formatFloodAreaRatio(value: Municipality["floodAreaRatio"]): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "未算出";
}

function formatMaxDepthDanger(value: Municipality["maxDepthDanger"]): string {
  return typeof value === "number" ? `${value} / 5` : "未算出";
}

type RadarPoint = {
  x: number;
  y: number;
};

type DisasterRadarItem = {
  label: string;
  value: number | null;
};

type OverallRanking = {
  nationalRank: number | null;
  nationalTotal: number;
  prefectureRank: number | null;
  prefectureTotal: number;
};

const DISASTER_RADAR_CENTER = 90;
const DISASTER_RADAR_RADIUS = 58;
const DISASTER_RADAR_LABEL_RADIUS = 78;

function getOptionalScore(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? clampScore(value) : null;
}

function getOverallRankingScore(municipality: Municipality): number | null {
  return getOptionalScore(municipality.overallScoreV2 ?? municipality.overallScore);
}

function calculateRank(target: Municipality, municipalities: Municipality[]): OverallRanking {
  const targetScore = getOverallRankingScore(target);
  const nationalScores = municipalities
    .map((municipality) => getOverallRankingScore(municipality))
    .filter((rankingScore): rankingScore is number => rankingScore !== null);
  const prefectureScores = municipalities
    .filter((municipality) => municipality.prefecture === target.prefecture)
    .map((municipality) => getOverallRankingScore(municipality))
    .filter((rankingScore): rankingScore is number => rankingScore !== null);

  if (targetScore === null) {
    return {
      nationalRank: null,
      nationalTotal: nationalScores.length,
      prefectureRank: null,
      prefectureTotal: prefectureScores.length,
    };
  }

  return {
    nationalRank: nationalScores.filter((rankingScore) => rankingScore > targetScore).length + 1,
    nationalTotal: nationalScores.length,
    prefectureRank: prefectureScores.filter((rankingScore) => rankingScore > targetScore).length + 1,
    prefectureTotal: prefectureScores.length,
  };
}

function getDisasterRadarPoint(index: number, total: number, value: number, radius: number): RadarPoint {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / total;
  const scaledRadius = radius * (value / 100);
  return {
    x: DISASTER_RADAR_CENTER + Math.cos(angle) * scaledRadius,
    y: DISASTER_RADAR_CENTER + Math.sin(angle) * scaledRadius,
  };
}

function formatRadarPoint(point: RadarPoint): string {
  return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
}

export default async function ResultPage({ params }: PageProps) {
  const { jisCode } = await params;
  const data = getMunicipalityByJisCode(jisCode);

  if (!data || !data.jisCode) {
    notFound();
  }

  const score = clampScore(data.overallScoreV2 ?? data.overallScore);
  const scoreVersionLabel = typeof data.overallScoreV2 === "number"
    ? (data.overallScoreV2Version ?? "v2")
    : "旧スコア";
  const levelLabel = getScoreLevelLabel(score);
  const floodStatusLabel        = getFloodStatusLabel(data.floodDataStatus);
  const landslideStatusLabel    = getLandslideStatusLabel(data.landslideDataStatus);
  const tsunamiStatusLabel      = getTsunamiStatusLabel(data.tsunamiDataStatus);
  const stormSurgeStatusLabel   = getStormSurgeStatusLabel(data.stormSurgeDataStatus);
  const liquefactionStatusLabel = getLiquefactionStatusLabel(data.liquefactionDataStatus);
  const overallRanking = calculateRank(data, getAllMunicipalities());
  const shelterRadarScore =
    typeof data.shelterScore === "number"
      ? data.shelterScore
      : typeof data.shelterCapacity === "number"
      ? data.shelterCapacity
      : null;
  const disasterRadarItems: DisasterRadarItem[] = [
    { label: "地震", value: getOptionalScore(data.earthquakeRisk) },
    { label: "洪水", value: getOptionalScore(data.floodRiskCandidate) },
    { label: "土砂", value: getOptionalScore(data.landslideRiskCandidate) },
    { label: "津波", value: getOptionalScore(data.tsunamiRiskCandidate) },
    { label: "高潮", value: getOptionalScore(data.stormSurgeRiskCandidate) },
    { label: "液状化", value: getOptionalScore(data.liquefactionRiskCandidate) },
    { label: "避難所", value: getOptionalScore(shelterRadarScore) },
    { label: "高齢化", value: getOptionalScore(data.agingRisk) },
    { label: "世帯", value: getOptionalScore(data.householdRisk) },
  ];
  const disasterRadarValidPointCount = disasterRadarItems.filter((item) => item.value !== null).length;
  const disasterRadarPolygonPoints = disasterRadarItems
    .map((item, index) =>
      item.value === null
        ? null
        : getDisasterRadarPoint(index, disasterRadarItems.length, item.value, DISASTER_RADAR_RADIUS),
    )
    .filter((point): point is RadarPoint => point !== null)
    .map(formatRadarPoint)
    .join(" ");

  const SITE_URL = "https://bousai-hensachi.vercel.app";
  const pageUrl = `${SITE_URL}${buildResultPath(data.jisCode)}`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "トップ", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "ランキング", item: `${SITE_URL}/ranking` },
          { "@type": "ListItem", position: 3, name: `${data.prefecture}${data.municipality}`, item: pageUrl },
        ],
      },
      {
        "@type": "Article",
        headline: `${data.prefecture}${data.municipality}の防災偏差値 ${score}`,
        description: data.comment,
        url: pageUrl,
        author: { "@type": "Organization", name: "全国防災偏差値" },
        dateModified: data.dataUpdatedAt ?? "2025-01-01",
      },
    ],
  };

  const aiComment = buildRuleBasedComment(data);
  const aiAdviceComment = buildAiAdviceComment(data);

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <div className="mx-auto max-w-md px-4 py-6 space-y-5">
        {/* ナビゲーション */}
        <nav className="flex items-center gap-2 text-sm text-gray-500">
          <Link href="/" className="hover:text-blue-600 transition-colors">
            ← トップへ戻る
          </Link>
          <span>/</span>
          <Link href="/ranking" className="hover:text-blue-600 transition-colors">
            ランキング
          </Link>
          <span>/</span>
          <span className="text-gray-800 font-medium">{data.municipality}</span>
        </nav>

        {/* 総合スコア */}
        <ScoreCard
          score={score}
          municipalityName={data.municipality}
          prefecture={data.prefecture}
        />

        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-bold text-gray-800 text-sm">総合防災偏差値 {scoreVersionLabel} の順位</h2>
            <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
              {scoreVersionLabel}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-blue-50 px-3 py-3 text-center">
              <p className="text-xs text-blue-700 mb-1">全国順位</p>
              {overallRanking.nationalRank === null ? (
                <p className="text-sm font-bold text-gray-500">順位未算出</p>
              ) : (
                <p className="text-xl font-bold text-blue-900 tabular-nums">
                  {overallRanking.nationalRank}
                  <span className="text-sm font-normal text-blue-700"> 位</span>
                </p>
              )}
              <p className="text-[11px] text-blue-700 mt-1 tabular-nums">
                / {overallRanking.nationalTotal}自治体
              </p>
            </div>
            <div className="rounded-xl bg-gray-50 px-3 py-3 text-center">
              <p className="text-xs text-gray-500 mb-1">{data.prefecture}内順位</p>
              {overallRanking.prefectureRank === null ? (
                <p className="text-sm font-bold text-gray-500">順位未算出</p>
              ) : (
                <p className="text-xl font-bold text-gray-800 tabular-nums">
                  {overallRanking.prefectureRank}
                  <span className="text-sm font-normal text-gray-500"> 位</span>
                </p>
              )}
              <p className="text-[11px] text-gray-500 mt-1 tabular-nums">
                / {overallRanking.prefectureTotal}自治体
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            同点の自治体は同順位です。順位は総合防災偏差値 {scoreVersionLabel} を基準に算出しています。
          </p>
        </section>

        {/* 防災スコアレーダー */}
        {typeof data.overallScoreV2 === "number" && (
          <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold text-gray-800 text-sm">防災スコアレーダー</h2>
              <p className="text-[10px] text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">0〜100 / 高いほど安全</p>
            </div>
            <svg
              viewBox="0 0 180 180"
              role="img"
              aria-label={`${data.prefecture}${data.municipality}の防災スコア内訳レーダーチャート`}
              className="mx-auto h-56 w-full max-w-xs"
            >
              {[25, 50, 75, 100].map((level) => (
                <polygon
                  key={level}
                  points={disasterRadarItems
                    .map((_, index) =>
                      formatRadarPoint(
                        getDisasterRadarPoint(
                          index,
                          disasterRadarItems.length,
                          level,
                          DISASTER_RADAR_RADIUS,
                        ),
                      ),
                    )
                    .join(" ")}
                  fill="none"
                  stroke="#bfdbfe"
                  strokeWidth="0.8"
                />
              ))}
              {disasterRadarItems.map((item, index) => {
                const edgePoint = getDisasterRadarPoint(
                  index,
                  disasterRadarItems.length,
                  100,
                  DISASTER_RADAR_RADIUS,
                );
                const labelPoint = getDisasterRadarPoint(
                  index,
                  disasterRadarItems.length,
                  100,
                  DISASTER_RADAR_LABEL_RADIUS,
                );
                return (
                  <g key={item.label}>
                    <line
                      x1={DISASTER_RADAR_CENTER}
                      y1={DISASTER_RADAR_CENTER}
                      x2={edgePoint.x}
                      y2={edgePoint.y}
                      stroke="#dbeafe"
                      strokeWidth="0.8"
                    />
                    <text
                      x={labelPoint.x}
                      y={labelPoint.y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-gray-500 text-[8px] font-medium"
                    >
                      {item.label}
                    </text>
                  </g>
                );
              })}
              {disasterRadarValidPointCount >= 3 && (
                <polygon
                  points={disasterRadarPolygonPoints}
                  fill="#2563eb"
                  fillOpacity="0.16"
                  stroke="#2563eb"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              )}
              {disasterRadarItems.map((item, index) => {
                if (item.value === null) return null;
                const point = getDisasterRadarPoint(
                  index,
                  disasterRadarItems.length,
                  item.value,
                  DISASTER_RADAR_RADIUS,
                );
                return (
                  <circle
                    key={`${item.label}-point`}
                    cx={point.x}
                    cy={point.y}
                    r="2.4"
                    fill="#1d4ed8"
                  />
                );
              })}
            </svg>
            <div className="grid grid-cols-6 gap-1 text-center">
              {disasterRadarItems.map((item) => (
                <div key={item.label} className="rounded-lg bg-gray-50 px-1.5 py-2">
                  <p className="text-[10px] text-gray-500 leading-tight">{item.label}</p>
                  <p className="text-xs font-bold text-gray-800 tabular-nums">
                    {item.value === null ? "未算出" : item.value}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 総合防災偏差値 v2.5 の内訳 */}
        {typeof data.overallScoreV2 === "number" && (
          <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-gray-800 text-sm">🧮 総合防災偏差値 {scoreVersionLabel} の内訳</h2>
              {data.overallScoreV2Version && (
                <span className="ml-auto text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
                  {data.overallScoreV2Version}
                </span>
              )}
            </div>

            {/* ハザード 40% */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 tracking-wide">ハザード（40%）</p>
              <div className="flex items-center gap-2">
                <span className="text-base" aria-hidden="true">🏔️</span>
                <span className="text-xs text-gray-600 flex-1">地震リスク</span>
                {typeof data.earthquakeRisk === "number" ? (
                  <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.earthquakeRisk))}`}>
                    {clampScore(data.earthquakeRisk)}
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
              </div>
              <div className="rounded-xl bg-gray-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-base" aria-hidden="true">🌊</span>
                  <span className="text-xs text-gray-600 flex-1">洪水リスク</span>
                  {typeof data.floodRiskCandidate === "number" ? (
                    <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.floodRiskCandidate))}`}>
                      {clampScore(data.floodRiskCandidate)}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">未算出</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400">データ状態</p>
                    <p className="font-medium text-gray-700 leading-snug">{floodStatusLabel}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">面積比率</p>
                    <p className="font-medium text-gray-700 tabular-nums">{formatFloodAreaRatio(data.floodAreaRatio)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">最大浸水深危険度</p>
                    <p className="font-medium text-gray-700 tabular-nums">{formatMaxDepthDanger(data.maxDepthDanger)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">スコア方向</p>
                    <p className="font-medium text-gray-700">高いほど安全</p>
                  </div>
                </div>
              </div>
              <div className="rounded-xl bg-gray-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-base" aria-hidden="true">⛰️</span>
                  <span className="text-xs text-gray-600 flex-1">土砂災害リスク</span>
                  {typeof data.landslideRiskCandidate === "number" ? (
                    <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.landslideRiskCandidate))}`}>
                      {clampScore(data.landslideRiskCandidate)}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">未算出</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400">データ状態</p>
                    <p className="font-medium text-gray-700 leading-snug">{landslideStatusLabel}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">警戒区域面積比</p>
                    <p className="font-medium text-gray-700 tabular-nums">{formatLandslideAreaRatio(data.landslideAreaRatio)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">特別警戒区域比</p>
                    <p className="font-medium text-gray-700 tabular-nums">{formatLandslideAreaRatio(data.landslideSpecialAreaRatio)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">スコア方向</p>
                    <p className="font-medium text-gray-700">高いほど安全</p>
                  </div>
                </div>
              </div>
              <div className="rounded-xl bg-gray-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-base" aria-hidden="true">🌊</span>
                  <span className="text-xs text-gray-600 flex-1">津波リスク</span>
                  {typeof data.tsunamiRiskCandidate === "number" ? (
                    <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.tsunamiRiskCandidate))}`}>
                      {clampScore(data.tsunamiRiskCandidate)}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">未算出</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400">データ状態</p>
                    <p className="font-medium text-gray-700 leading-snug">{tsunamiStatusLabel}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">浸水面積比率</p>
                    <p className="font-medium text-gray-700 tabular-nums">
                      {typeof data.tsunamiAreaRatio === "number"
                        ? `${(data.tsunamiAreaRatio * 100).toFixed(1)}%`
                        : "未算出"}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">最大浸水深下限</p>
                    <p className="font-medium text-gray-700 tabular-nums">
                      {formatTsunamiMaxDepth(data.tsunamiDataStatus, data.tsunamiMaxDepthM)}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">スコア方向</p>
                    <p className="font-medium text-gray-700">高いほど安全</p>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-gray-500">
                  津波スコアは国土数値情報A40を基に算出しています。データ未提供地域は津波項目を総合スコア計算から除外しています。
                </p>
              </div>
              <div className="rounded-xl bg-gray-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-base" aria-hidden="true">🌀</span>
                  <span className="text-xs text-gray-600 flex-1">高潮リスク</span>
                  {typeof data.stormSurgeRiskCandidate === "number" ? (
                    <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.stormSurgeRiskCandidate))}`}>
                      {clampScore(data.stormSurgeRiskCandidate)}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">未算出</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400">データ状態</p>
                    <p className="font-medium text-gray-700 leading-snug">{stormSurgeStatusLabel}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">浸水面積比率</p>
                    <p className="font-medium text-gray-700 tabular-nums">
                      {typeof data.stormSurgeAreaRatio === "number"
                        ? `${(data.stormSurgeAreaRatio * 100).toFixed(1)}%`
                        : "未算出"}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">最大浸水深下限</p>
                    <p className="font-medium text-gray-700 tabular-nums">
                      {formatStormSurgeMaxDepth(data.stormSurgeDataStatus, data.stormSurgeMaxDepthM)}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">スコア方向</p>
                    <p className="font-medium text-gray-700">高いほど安全</p>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-gray-500">
                  高潮スコアは国土数値情報A49を基に算出しています。データ未整備地域は高潮項目を総合スコア計算から除外しています。
                </p>
              </div>
              <div className="rounded-xl bg-gray-50 px-3 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-base" aria-hidden="true">🌱</span>
                  <span className="text-xs text-gray-600 flex-1">液状化発生傾向</span>
                  {typeof data.liquefactionRiskCandidate === "number" ? (
                    <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.liquefactionRiskCandidate))}`}>
                      {clampScore(data.liquefactionRiskCandidate)}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">未算出</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400">データ状態</p>
                    <p className="font-medium text-gray-700 leading-snug">{liquefactionStatusLabel}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">液状化傾向地面積比</p>
                    <p className="font-medium text-gray-700 tabular-nums">
                      {typeof data.liquefactionSusceptibleAreaRatio === "number"
                        ? `${(data.liquefactionSusceptibleAreaRatio * 100).toFixed(1)}%`
                        : "未算出"}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">高リスク地面積比</p>
                    <p className="font-medium text-gray-700 tabular-nums">
                      {typeof data.liquefactionHighRiskAreaRatio === "number"
                        ? `${(data.liquefactionHighRiskAreaRatio * 100).toFixed(1)}%`
                        : "未算出"}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400">代表地形</p>
                    <p className="font-medium text-gray-700">{data.liquefactionMaxRiskClass ?? "—"}</p>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-gray-500">
                  液状化スコアはJ-SHIS 250mメッシュ微地形区分（若松・松岡2020）に基づく地形由来の発生傾向指標です。個別地点の地盤状態や実際の液状化被害を保証するものではありません。
                </p>
              </div>
            </div>

            {/* インフラ 30% */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 tracking-wide">インフラ（30%）</p>
              {(() => {
                const infraVal =
                  typeof data.shelterScore === "number" && data.shelterScore !== null
                    ? data.shelterScore
                    : typeof data.shelterCapacity === "number"
                    ? data.shelterCapacity
                    : null;
                const isCapacityFallback =
                  !(typeof data.shelterScore === "number" && data.shelterScore !== null);
                return (
                  <div className="flex items-center gap-2">
                    <span className="text-base" aria-hidden="true">🏠</span>
                    <span className="text-xs text-gray-600 flex-1">
                      避難所充足度{isCapacityFallback && <span className="text-gray-400">（容量ベース）</span>}
                    </span>
                    {infraVal !== null ? (
                      <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(infraVal))}`}>
                        {clampScore(infraVal)}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* 社会脆弱性 30% */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 tracking-wide">社会脆弱性（30%）</p>
              <div className="flex items-center gap-2">
                <span className="text-base" aria-hidden="true">👥</span>
                <span className="text-xs text-gray-600 flex-1">高齢化リスク</span>
                {typeof data.agingRisk === "number" ? (
                  <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.agingRisk))}`}>
                    {clampScore(data.agingRisk)}
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-base" aria-hidden="true">🏘️</span>
                <span className="text-xs text-gray-600 flex-1">世帯脆弱リスク</span>
                {typeof data.householdRisk === "number" ? (
                  <span className={`text-sm font-bold tabular-nums ${getScoreLevelColor(clampScore(data.householdRisk))}`}>
                    {clampScore(data.householdRisk)}
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
              </div>
            </div>

            <p className="text-xs text-gray-400 leading-relaxed pt-1 border-t border-gray-50">
              ランキング・検索候補の表示は総合防災偏差値 {scoreVersionLabel} を優先します。一部詳細指標は旧v1項目を含みます。
            </p>
          </section>
        )}

        {/* AI風コメント */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-1">
          <p className="text-xs text-gray-400 mb-1">TEMMEI診断コメント</p>
          <p className="text-sm text-gray-700 leading-relaxed">{aiComment}</p>
          <p className="text-xs text-gray-500 mt-1 pt-1 border-t border-gray-50">{data.comment}</p>
        </div>

        {/* 防災アドバイス */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">防災アドバイス</h2>
          <p className="text-sm text-gray-700 leading-relaxed">{aiAdviceComment}</p>
        </section>

        {/* 行動提案 */}
        <section className="bg-blue-50 rounded-2xl border border-blue-100 p-5 space-y-3">
          <h2 className="font-bold text-blue-800 text-sm">
            💡 今日からできる防災アクション
          </h2>
          <ul className="space-y-2">
            {data.actionTips.map((tip, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-blue-900">
                <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-blue-200 text-blue-700 text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                {tip}
              </li>
            ))}
          </ul>
        </section>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-24" />

        {/* SNSシェア */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <ShareButtons
            score={score}
            municipalityName={data.municipality}
            prefecture={data.prefecture}
          />
        </div>

        {/* 注意事項 */}
        <Disclaimer sourceNote={data.sourceNote} />

        {/* ナビゲーション導線 */}
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/"
            className="flex items-center justify-center py-3 rounded-xl border border-gray-200 text-sm text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            別の街を診断
          </Link>
          <Link
            href="/ranking"
            className="flex items-center justify-center py-3 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 transition-colors"
          >
            ランキングを見る
          </Link>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Link
            href="/ranking/emotional"
            className="flex items-center justify-center py-2 rounded-xl border border-gray-200 text-xs text-gray-700 font-medium hover:bg-gray-50 transition-colors text-center leading-tight"
          >
            感情回復力<br/>ランキング
          </Link>
          <Link
            href="/ranking/social"
            className="flex items-center justify-center py-2 rounded-xl border border-gray-200 text-xs text-gray-700 font-medium hover:bg-gray-50 transition-colors text-center leading-tight"
          >
            社会回復力<br/>ランキング
          </Link>
          <Link
            href="/methodology"
            className="flex items-center justify-center py-2 rounded-xl border border-gray-200 text-xs text-gray-700 font-medium hover:bg-gray-50 transition-colors text-center leading-tight"
          >
            算出方法を<br/>知る
          </Link>
        </div>

        {/* フッター */}
        <footer className="text-center text-xs text-gray-400 space-y-1 pb-4">
          <p>© 2025 全国防災偏差値</p>
          <p>{data.prefecture}{data.municipality}の防災偏差値: {score}（{levelLabel}）</p>
          <Link href="/sources" className="hover:text-blue-500 transition-colors underline">
            データ出典・免責事項
          </Link>
        </footer>
      </div>
    </div>
  );
}
