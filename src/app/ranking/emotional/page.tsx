import type { Metadata } from "next";
import Link from "next/link";
import { buildResultPath, getCategoryRanking } from "@/lib/municipalities";
import { calcCategoryScore, clampScore, getScoreLevelColor, SCORE_ITEMS } from "@/lib/score";
import type { ScoreKey } from "@/lib/score";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import { safeJsonLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "感情回復力ランキング | 全国防災偏差値",
  description:
    "孤立リスク・子育てストレス・感情回復・家族防災力を総合した「感情回復力」で全国市区町村をランキング。",
};

const emotionalItems = SCORE_ITEMS.filter(
  (i) => i.visible && i.category === "emotional"
);

export default function EmotionalRankingPage() {
  const ranking = getCategoryRanking("emotional");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "感情回復力ランキング",
    description: metadata.description,
    url: "https://bousai-hensachi.vercel.app/ranking/emotional",
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-50 to-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <div className="mx-auto max-w-md px-4 py-6 space-y-5">
        <nav className="flex items-center justify-between text-sm">
          <Link href="/ranking" className="text-gray-500 hover:text-purple-600 transition-colors">
            ← ランキングトップへ
          </Link>
          <Link href="/methodology" className="text-xs text-gray-400 hover:text-purple-600 transition-colors">
            算出方法
          </Link>
        </nav>

        <header className="space-y-1">
          <h1 className="text-xl font-extrabold text-gray-900">💚 感情回復力ランキング</h1>
          <p className="text-xs text-gray-500">
            孤立・子育てストレス・感情回復・家族防災力から算出したTEMMEI独自スコア
          </p>
        </header>

        {/* 指標説明 */}
        <section className="bg-purple-50 border border-purple-100 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-semibold text-purple-800">対象指標</p>
          <div className="grid grid-cols-2 gap-2">
            {emotionalItems.map((item) => (
              <div key={item.key} className="flex items-center gap-1.5 text-xs text-purple-700">
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </section>

        <AdPlaceholder label="広告" className="h-16" />

        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
          <span>⚠️</span>
          <span>避難所データはGSI指定避難所CSVを反映済みです。一部指標は初期値・設計値を含みます。</span>
          <Link href="/sources" className="underline font-medium whitespace-nowrap">詳細</Link>
        </div>

        {/* ランキングリスト */}
        <section className="space-y-2">
          {ranking.slice(0, 20).map((m, i) => {
            const score = calcCategoryScore(
              m as Partial<Record<ScoreKey, number>>,
              "emotional"
            ) ?? 0;
            const color = getScoreLevelColor(score);
            const path = buildResultPath(m.jisCode);
            if (!path) return null;
            return (
              <Link
                key={m.id}
                href={path}
                className="flex items-center gap-3 bg-white rounded-xl border border-gray-100 px-4 py-3 shadow-sm hover:border-purple-200 transition-colors"
              >
                <span className="text-sm font-bold text-gray-400 w-7 text-right tabular-nums">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-400">{m.prefecture}</p>
                  <p className="text-sm font-semibold text-gray-800 truncate">{m.municipality}</p>
                </div>
                <div className={`text-xl font-bold tabular-nums ${color}`}>
                  {clampScore(score)}
                </div>
              </Link>
            );
          })}
        </section>

        <AdPlaceholder label="広告" className="h-24" />

        <Disclaimer />

        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/ranking/social"
            className="flex items-center justify-center py-3 rounded-xl border border-gray-200 text-sm text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            社会回復力を見る
          </Link>
          <Link
            href="/"
            className="flex items-center justify-center py-3 rounded-xl bg-purple-600 text-sm text-white font-medium hover:bg-purple-700 transition-colors"
          >
            街を診断する
          </Link>
        </div>

        <footer className="text-center text-xs text-gray-400 space-y-1 pb-4">
          <p>© 2025 全国防災偏差値</p>
          <Link href="/sources" className="hover:text-blue-500 transition-colors">
            データ出典・免責事項
          </Link>
        </footer>
      </div>
    </div>
  );
}
