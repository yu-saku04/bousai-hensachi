import type { Metadata } from "next";
import Link from "next/link";
import { getRanking, getAllPrefectures } from "@/lib/municipalities";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import PrefectureFilter from "@/components/PrefectureFilter";
import RankingList from "@/components/RankingList";
import ScoreLegend from "@/components/ScoreLegend";

export const metadata: Metadata = {
  title: "全国防災偏差値ランキング | 全国防災偏差値",
  description: "全国の市区町村を防災偏差値でランキング。都道府県別フィルター・感情回復力・社会回復力ランキングも。",
};

export default function RankingPage() {
  const ranking = getRanking();
  const prefectures = getAllPrefectures();

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="mx-auto max-w-md px-4 py-6 space-y-5">
        <header className="space-y-1">
          <nav className="flex items-center justify-between text-sm mb-2">
            <Link href="/" className="text-gray-500 hover:text-blue-600 transition-colors">
              ← トップへ戻る
            </Link>
            <Link href="/sources" className="text-xs text-gray-400 hover:text-blue-600 transition-colors">
              データ出典
            </Link>
          </nav>
          <h1 className="text-xl font-extrabold text-gray-900">🏆 全国防災偏差値ランキング</h1>
          <p className="text-xs text-gray-500">
            防災偏差値が高いほど「比較的安全・体制が整っている」地域です
          </p>
        </header>

        <AdPlaceholder label="広告" className="h-16" />

        {/* カテゴリ別ランキングへのリンク */}
        <div className="grid grid-cols-2 gap-2">
          <Link
            href="/ranking/emotional"
            className="flex items-center gap-2 px-4 py-3 bg-purple-50 border border-purple-100 rounded-xl text-sm font-medium text-purple-800 hover:bg-purple-100 transition-colors"
          >
            <span>💚</span>
            <span>感情回復力<br/><span className="text-xs font-normal text-purple-600">孤立・子育て・感情</span></span>
          </Link>
          <Link
            href="/ranking/social"
            className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-xl text-sm font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
          >
            <span>🤝</span>
            <span>社会回復力<br/><span className="text-xs font-normal text-emerald-600">避難所・支援・インフラ</span></span>
          </Link>
        </div>

        <section className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
          <PrefectureFilter prefectures={prefectures} selected="" />
        </section>

        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
          <span>⚠️</span>
          <span>避難所データはGSI指定避難所CSVを反映済みです。一部指標は初期値・設計値を含みます。</span>
          <Link href="/sources" className="underline font-medium whitespace-nowrap">詳細</Link>
        </div>

        <RankingList ranking={ranking} />

        <AdPlaceholder label="広告" className="h-24" />

        <ScoreLegend />

        <Disclaimer />

        <Link
          href="/"
          className="block w-full text-center py-4 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 transition-colors"
        >
          あなたの街を診断する
        </Link>

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
