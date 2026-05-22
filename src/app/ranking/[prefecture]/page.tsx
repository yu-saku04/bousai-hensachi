import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getPrefectureRanking, getAllPrefectures } from "@/lib/municipalities";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import PrefectureFilter from "@/components/PrefectureFilter";
import RankingList from "@/components/RankingList";
import ScoreLegend from "@/components/ScoreLegend";

export const dynamicParams = false;

interface PageProps {
  params: Promise<{ prefecture: string }>;
}

export async function generateStaticParams() {
  // 生文字列を返す。Next.js がURLエンコードを管理するため encodeURIComponent 不要
  return getAllPrefectures().map((pref) => ({
    prefecture: pref,
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { prefecture } = await params;
  const decodedPref = safeDecodeParam(prefecture);
  return {
    title: `${decodedPref} 防災偏差値ランキング | 全国防災偏差値`,
    description: `${decodedPref}の市区町村を防災偏差値でランキング表示します。`,
  };
}

function safeDecodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function PrefectureRankingPage({ params }: PageProps) {
  const { prefecture: prefParam } = await params;
  const decodedPref = safeDecodeParam(prefParam);

  const allPrefectures = getAllPrefectures();
  if (!allPrefectures.includes(decodedPref)) {
    notFound();
  }

  const ranking = getPrefectureRanking(decodedPref);

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="mx-auto max-w-md px-4 py-6 space-y-5">
        <header className="space-y-1">
          <nav className="flex items-center justify-between text-sm mb-2">
            <Link href="/ranking" className="text-gray-500 hover:text-blue-600 transition-colors">
              ← 全国ランキング
            </Link>
            <Link href="/sources" className="text-xs text-gray-400 hover:text-blue-600 transition-colors">
              データ出典
            </Link>
          </nav>
          <h1 className="text-xl font-extrabold text-gray-900">
            🏆 {decodedPref} ランキング
          </h1>
          <p className="text-xs text-gray-500">
            {decodedPref}内 {ranking.length}件の市区町村を防災偏差値順で表示
          </p>
        </header>

        <AdPlaceholder label="広告" className="h-16" />

        <section className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
          <PrefectureFilter prefectures={allPrefectures} selected={decodedPref} />
        </section>

        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
          <span>⚠️</span>
          <span>現在表示しているデータはMVP用の仮データです。</span>
          <Link href="/sources" className="underline font-medium whitespace-nowrap">詳細</Link>
        </div>

        <RankingList ranking={ranking} />

        <AdPlaceholder label="広告" className="h-24" />

        <ScoreLegend />

        <Disclaimer />

        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/"
            className="flex items-center justify-center py-3 rounded-xl border border-gray-200 text-sm text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            あなたの街を診断
          </Link>
          <Link
            href="/ranking"
            className="flex items-center justify-center py-3 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 transition-colors"
          >
            全国ランキング
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
