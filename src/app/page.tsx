import Link from "next/link";
import SearchForm from "@/components/SearchForm";
import AdPlaceholder from "@/components/AdPlaceholder";
import { getRanking } from "@/lib/municipalities";
import { getScoreLevelLabel, getScoreLevelColor } from "@/lib/score";

export default function HomePage() {
  const topRanking = getRanking().slice(0, 3);

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="mx-auto max-w-md px-4 py-8 space-y-6">
        {/* ヘッダー */}
        <header className="text-center space-y-2">
          <div className="text-3xl mb-1">🛡️</div>
          <h1 className="text-2xl font-extrabold text-gray-900">全国防災偏差値</h1>
          <p className="text-sm text-blue-600 font-medium">
            あなたの街の災害リスクを、わかりやすく数値化
          </p>
          <p className="text-xs text-gray-500 leading-relaxed pt-1">
            難しい防災データを「偏差値」でひと目判断。
            <br />
            不安を煽るのではなく、今日できる行動へ。
          </p>
        </header>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-16" />

        {/* 検索フォーム */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
          <h2 className="font-bold text-gray-800">あなたの街を診断する</h2>
          <SearchForm />
        </section>

        {/* ランキングプレビュー */}
        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-gray-800">🏆 防災偏差値 TOP3</h2>
            <Link
              href="/ranking"
              className="text-xs text-blue-600 font-medium hover:underline"
            >
              全件見る →
            </Link>
          </div>
          <ol className="space-y-2">
            {topRanking.map((m, i) => (
              <li key={m.id}>
                <Link
                  href={`/result/${encodeURIComponent(m.prefecture)}/${encodeURIComponent(m.municipality)}`}
                  className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <span className="text-lg font-bold text-gray-400 w-6 text-center">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-800 text-sm truncate">
                      {m.municipality}
                    </p>
                    <p className="text-xs text-gray-400">{m.prefecture}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-xl font-extrabold tabular-nums ${getScoreLevelColor(m.overallScore)}`}>
                      {m.overallScore}
                    </p>
                    <p className={`text-xs ${getScoreLevelColor(m.overallScore)}`}>
                      {getScoreLevelLabel(m.overallScore)}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ol>
          <Link
            href="/ranking"
            className="block w-full text-center text-sm text-blue-600 font-medium py-2 rounded-xl border border-blue-100 hover:bg-blue-50 transition-colors"
          >
            全国ランキングを見る
          </Link>
        </section>

        {/* 仮データ注意 */}
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-700">
          <span>⚠️</span>
          <span>現在表示しているデータはMVP用の仮データです。</span>
          <Link href="/sources" className="underline font-medium whitespace-nowrap">詳細</Link>
        </div>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-24" />

        {/* フッター */}
        <footer className="text-center text-xs text-gray-400 space-y-1 pb-4">
          <p>© 2025 全国防災偏差値</p>
          <p>防災情報は必ず各自治体・公的機関の情報も合わせてご確認ください</p>
          <Link href="/sources" className="hover:text-blue-500 transition-colors underline">
            データ出典・免責事項
          </Link>
        </footer>
      </div>
    </div>
  );
}
