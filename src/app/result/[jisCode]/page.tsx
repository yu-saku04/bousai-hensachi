import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getMunicipalityByJisCode, getAllMunicipalities, buildResultPath } from "@/lib/municipalities";
import { safeJsonLd } from "@/lib/json-ld";
import {
  getScoreLevelLabel,
  clampScore,
  SCORE_ITEMS,
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  calcCategoryScore,
  getScoreLevelColor,
  getScoreBarColor,
} from "@/lib/score";
import type { ScoreCategory, ScoreKey } from "@/lib/score";
import ScoreCard from "@/components/ScoreCard";
import ShareButtons from "@/components/ShareButtons";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import RadarChartWrapper from "@/components/RadarChartWrapper";
import type { Municipality } from "@/types/municipality";

export const dynamicParams = false;

interface PageProps {
  params: Promise<{ jisCode: string }>;
}

export async function generateStaticParams() {
  return getAllMunicipalities().map((m) => {
    if (!m.jisCode) {
      throw new Error(`result SSG生成エラー: jisCode未設定 (${m.id})`);
    }
    return { jisCode: m.jisCode };
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { jisCode } = await params;
  const data = getMunicipalityByJisCode(jisCode);
  if (!data) return { title: "データが見つかりません | 全国防災偏差値" };
  if (!data.jisCode) return { title: "データが見つかりません | 全国防災偏差値" };

  const SITE_URL = "https://bousai-hensachi.vercel.app";
  const title = `${data.prefecture}${data.municipality}の防災偏差値 ${data.overallScore}`;
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

const categories: ScoreCategory[] = ["physical", "social", "emotional"];

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

  const overall = data.overallScore;
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

export default async function ResultPage({ params }: PageProps) {
  const { jisCode } = await params;
  const data = getMunicipalityByJisCode(jisCode);

  if (!data || !data.jisCode) {
    notFound();
  }

  const score = clampScore(data.overallScore);
  const levelLabel = getScoreLevelLabel(score);
  const scores = data as Partial<Record<ScoreKey, number>>;

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

  // RadarChart 用データを RSC で計算してクライアントへ渡す（Municipality 全体を渡さない）
  const radarData = SCORE_ITEMS
    .filter((item) => item.visible)
    .map((item) => ({
      subject: item.shortLabel,
      score: clampScore((data as unknown as Record<string, number>)[item.key] ?? 0),
      fullMark: 100 as const,
    }));

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

        {/* AI風コメント */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-1">
          <p className="text-xs text-gray-400 mb-1">TEMMEI診断コメント</p>
          <p className="text-sm text-gray-700 leading-relaxed">{aiComment}</p>
          <p className="text-xs text-gray-500 mt-1 pt-1 border-t border-gray-50">{data.comment}</p>
        </div>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-20" />

        {/* レーダーチャート */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 text-sm mb-3">防災レーダーチャート</h2>
          <RadarChartWrapper data={radarData} />
        </section>

        {/* 3カテゴリスコア */}
        <section className="space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">カテゴリ別スコア</h2>
          <div className="grid grid-cols-3 gap-2">
            {categories.map((cat) => {
              const catScore = calcCategoryScore(scores, cat);
              const displayScore = catScore ?? 0;
              const color = getScoreLevelColor(displayScore);
              return (
                <div
                  key={cat}
                  className="bg-white rounded-xl border border-gray-100 p-3 text-center shadow-sm"
                >
                  <div className="text-xl mb-1">{CATEGORY_ICONS[cat]}</div>
                  <div className={`text-2xl font-bold tabular-nums ${color}`}>{displayScore}</div>
                  <div className="text-xs text-gray-500 mt-1">{CATEGORY_LABELS[cat]}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 指標タブ詳細 */}
        {categories.map((cat) => {
          const items = SCORE_ITEMS.filter((i) => i.visible && i.category === cat);
          const catScore = calcCategoryScore(scores, cat) ?? 0;
          const hasData = items.some((item) => {
            const raw = data[item.key as keyof Municipality];
            return typeof raw === "number";
          });
          if (!hasData) return null;

          return (
            <section key={cat} className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">{CATEGORY_ICONS[cat]}</span>
                <h2 className="font-bold text-gray-800 text-sm">{CATEGORY_LABELS[cat]}</h2>
                <span className={`ml-auto text-lg font-bold tabular-nums ${getScoreLevelColor(catScore)}`}>
                  {catScore}
                </span>
              </div>
              <div className="space-y-3">
                {items.map((item) => {
                  const raw = data[item.key as keyof Municipality];
                  if (typeof raw !== "number") return null;
                  const itemScore = clampScore(raw);
                  const color = getScoreLevelColor(itemScore);
                  const barColor = getScoreBarColor(itemScore);
                  return (
                    <div key={item.key}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-base" role="img" aria-label={item.label}>{item.icon}</span>
                        <div className="flex-1">
                          <p className="text-xs font-semibold text-gray-700">{item.label}</p>
                          <p className="text-xs text-gray-400">{item.description}</p>
                        </div>
                        <div className={`text-lg font-bold tabular-nums ${color}`}>{itemScore}</div>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${itemScore}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

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

        {/* SNSシェア */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <ShareButtons
            score={score}
            municipalityName={data.municipality}
            prefecture={data.prefecture}
          />
        </div>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-24" />

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
