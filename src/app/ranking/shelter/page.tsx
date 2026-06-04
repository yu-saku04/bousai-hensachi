import type { Metadata } from "next";
import Link from "next/link";
import { buildResultPath, getShelterRanking } from "@/lib/municipalities";
import { getScoreLevelColor } from "@/lib/score";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import { safeJsonLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "避難所充足偏差値ランキング | 全国防災偏差値",
  description:
    "人口1万人あたりの指定避難所数を全国比較した避難所充足偏差値で市区町村をランキング。GSI指定避難所データと国勢調査人口をもとに算出。",
};

export default function ShelterRankingPage() {
  const ranking = getShelterRanking().slice(0, 100);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "避難所充足偏差値ランキング",
    description: metadata.description,
    url: "https://bousai-hensachi.vercel.app/ranking/shelter",
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-cyan-50 to-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <div className="mx-auto max-w-md px-4 py-6 space-y-5">
        <nav className="flex items-center justify-between text-sm">
          <Link href="/ranking" className="text-gray-500 hover:text-cyan-600 transition-colors">
            ← ランキングトップへ
          </Link>
          <Link href="/methodology" className="text-xs text-gray-400 hover:text-cyan-600 transition-colors">
            算出方法
          </Link>
        </nav>

        <header className="space-y-1">
          <h1 className="text-xl font-extrabold text-gray-900">🏠 避難所充足偏差値ランキング</h1>
          <p className="text-xs text-gray-500">
            上位100件を表示（GSI避難所データあり {ranking.length}件中）
          </p>
        </header>

        {/* 指標説明 */}
        <section className="bg-cyan-50 border border-cyan-100 rounded-2xl p-4 space-y-1">
          <p className="text-xs font-semibold text-cyan-800">この指標について</p>
          <p className="text-xs text-cyan-700 leading-relaxed">
            GSI指定避難所データと2020年国勢調査人口をもとに、人口1万人あたりの指定避難所数を全国比較した暫定指標です。
          </p>
        </section>

        <AdPlaceholder label="広告" className="h-16" />

        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
          <span>⚠️</span>
          <span>GSI避難所データを未提出の自治体（約195件）はこのランキングに含まれません。</span>
          <Link href="/sources" className="underline font-medium whitespace-nowrap">詳細</Link>
        </div>

        {/* ランキングリスト */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 bg-gray-50 grid grid-cols-12 text-xs text-gray-400 font-medium">
            <span className="col-span-1 text-center">順位</span>
            <span className="col-span-6 pl-2">市区町村</span>
            <span className="col-span-3 text-right">偏差値</span>
            <span className="col-span-2 text-right">1万人<br />あたり</span>
          </div>
          <ol>
            {ranking.map((m, i) => {
              const path = buildResultPath(m.jisCode);
              if (!path) return null;
              const rank = i + 1;
              const rankEmoji = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
              const score = m.shelterScore ?? 0;
              const color = getScoreLevelColor(score);
              const per10k = m.shelterCountPer10k != null
                ? m.shelterCountPer10k.toFixed(1)
                : "—";
              return (
                <li key={m.id} className="border-b border-gray-50 last:border-none">
                  <Link
                    href={path}
                    className="grid grid-cols-12 items-center px-4 py-3 hover:bg-cyan-50 transition-colors"
                  >
                    <span className="col-span-1 text-center text-sm font-bold text-gray-400">
                      {rankEmoji ?? rank}
                    </span>
                    <div className="col-span-6 pl-2 min-w-0">
                      <p className="font-semibold text-gray-800 text-sm truncate">{m.municipality}</p>
                      <p className="text-xs text-gray-400 truncate">{m.prefecture}</p>
                    </div>
                    <div className="col-span-3 text-right">
                      <span className={`text-lg font-extrabold tabular-nums ${color}`}>
                        {score}
                      </span>
                    </div>
                    <div className="col-span-2 text-right">
                      <span className="text-sm font-medium text-gray-600 tabular-nums">{per10k}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>

        <AdPlaceholder label="広告" className="h-24" />

        <Disclaimer />

        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/ranking"
            className="flex items-center justify-center py-3 rounded-xl border border-gray-200 text-sm text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            ランキングトップへ
          </Link>
          <Link
            href="/"
            className="flex items-center justify-center py-3 rounded-xl bg-cyan-600 text-sm text-white font-medium hover:bg-cyan-700 transition-colors"
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
