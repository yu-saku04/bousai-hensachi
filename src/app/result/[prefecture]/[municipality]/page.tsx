import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getMunicipalityByParams, getAllMunicipalities } from "@/lib/municipalities";
import { getScoreLevelLabel, clampScore } from "@/lib/score";
import ScoreCard from "@/components/ScoreCard";
import RiskCard from "@/components/RiskCard";
import ShareButtons from "@/components/ShareButtons";
import AdPlaceholder from "@/components/AdPlaceholder";
import Disclaimer from "@/components/Disclaimer";
import { RISK_ITEMS } from "@/types/municipality";

export const dynamicParams = false;

interface PageProps {
  params: Promise<{ prefecture: string; municipality: string }>;
}

export async function generateStaticParams() {
  // 生文字列を返す。Next.js がURLエンコードを管理するため encodeURIComponent 不要
  return getAllMunicipalities().map((m) => ({
    prefecture: m.prefecture,
    municipality: m.municipality,
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { prefecture, municipality } = await params;
  const data = getMunicipalityByParams(prefecture, municipality);
  if (!data) return { title: "データが見つかりません | 全国防災偏差値" };
  return {
    title: `${data.prefecture}${data.municipality}の防災偏差値 ${data.overallScore} | 全国防災偏差値`,
    description: data.comment,
  };
}

export default async function ResultPage({ params }: PageProps) {
  const { prefecture, municipality } = await params;
  const data = getMunicipalityByParams(prefecture, municipality);

  if (!data) {
    notFound();
  }

  const score = clampScore(data.overallScore);
  const levelLabel = getScoreLevelLabel(score);

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="mx-auto max-w-md px-4 py-6 space-y-5">
        {/* ナビゲーション */}
        <nav className="flex items-center gap-2 text-sm text-gray-500">
          <Link href="/" className="hover:text-blue-600 transition-colors">
            ← トップへ戻る
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

        {/* 一言コメント */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <p className="text-xs text-gray-400 mb-1">診断コメント</p>
          <p className="text-sm text-gray-700 leading-relaxed">{data.comment}</p>
        </div>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-20" />

        {/* リスク詳細 */}
        <section className="space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">リスク詳細</h2>
          <p className="text-xs text-gray-400">
            スコアが高いほど「安全・余裕あり」を示します（0〜100）
          </p>
          <div className="space-y-3">
            {RISK_ITEMS.map((item) => (
              <RiskCard key={item.key} item={item} municipality={data} />
            ))}
          </div>
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
