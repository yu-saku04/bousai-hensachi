import type { Metadata } from "next";
import Link from "next/link";
import AdPlaceholder from "@/components/AdPlaceholder";

export const metadata: Metadata = {
  title: "データ出典・免責事項 | 全国防災偏差値",
  description:
    "全国防災偏差値で使用しているデータの出典と、サービスの免責事項についてご説明します。",
};

const DATA_SOURCES = [
  {
    org: "国土交通省",
    items: [
      "洪水浸水想定区域図",
      "土砂災害警戒区域・特別警戒区域",
      "河川整備状況データ",
    ],
    url: "https://www.mlit.go.jp/",
    status: "future",
  },
  {
    org: "気象庁",
    items: [
      "地震動予測地図",
      "活断層の位置情報",
      "過去の地震・水害発生データ",
    ],
    url: "https://www.jma.go.jp/",
    status: "future",
  },
  {
    org: "消防庁",
    items: [
      "火災統計",
      "消防力の整備指針",
      "避難所整備状況",
    ],
    url: "https://www.fdma.go.jp/",
    status: "future",
  },
  {
    org: "総務省統計局",
    items: [
      "国勢調査（人口・高齢化率）",
      "住民基本台帳人口移動報告",
    ],
    url: "https://www.stat.go.jp/",
    status: "future",
  },
  {
    org: "各自治体オープンデータ",
    items: [
      "避難所・避難場所一覧",
      "地域防災計画",
      "ハザードマップ",
    ],
    url: null,
    status: "future",
  },
];

export default function SourcesPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="mx-auto max-w-md px-4 py-6 space-y-6">
        {/* ナビゲーション */}
        <nav className="flex items-center justify-between text-sm">
          <Link href="/" className="text-gray-500 hover:text-blue-600 transition-colors">
            ← トップへ戻る
          </Link>
          <Link href="/ranking" className="text-xs text-gray-400 hover:text-blue-600 transition-colors">
            ランキング
          </Link>
        </nav>

        {/* ヘッダー */}
        <header>
          <h1 className="text-xl font-extrabold text-gray-900 mb-1">📋 データ出典・免責事項</h1>
          <p className="text-xs text-gray-500">
            本サービスで使用しているデータの出典と、ご利用にあたっての注意事項です。
          </p>
        </header>

        {/* 現在のデータ状態 */}
        <section className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-3">
          <h2 className="font-bold text-amber-800 text-sm">⚠️ 現在のデータについて</h2>
          <p className="text-sm text-amber-900 leading-relaxed">
            現在表示されているすべてのスコアデータは、<strong>サービス開発・検証用の仮データ</strong>です。
            実際の防災リスクを反映したものではありません。
          </p>
          <p className="text-sm text-amber-900 leading-relaxed">
            今後、下記の公的機関が公開するオープンデータをもとに、実データへの更新を予定しています。
          </p>
        </section>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-16" />

        {/* 利用予定データ一覧 */}
        <section className="space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">利用予定のデータ出典</h2>
          <div className="space-y-3">
            {DATA_SOURCES.map((source) => (
              <div
                key={source.org}
                className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm space-y-2"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-800 text-sm">{source.org}</h3>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    導入予定
                  </span>
                </div>
                <ul className="space-y-1">
                  {source.items.map((item) => (
                    <li key={item} className="text-xs text-gray-600 flex items-start gap-1.5">
                      <span className="text-gray-300 mt-0.5">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
                {source.url && (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-500 hover:underline"
                  >
                    公式サイト →
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* スコアについて */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">スコアの算出方法について</h2>
          <div className="space-y-2 text-sm text-gray-600 leading-relaxed">
            <p>
              「防災偏差値」は、当サービスが独自に設定した指標にもとづいて算出した
              <strong>参考値</strong>です。
            </p>
            <p>
              洪水リスク・地震リスク・火災リスク・高齢化リスク・避難所余裕度の5項目を
              加重平均し、0〜100のスコアとして表示しています。
            </p>
            <p>
              このスコアは、国または自治体による公式の防災評価・格付けではありません。
            </p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3 text-xs text-gray-500 space-y-1">
            <p>重み付け（参考・現在の仮設定）</p>
            <ul className="space-y-0.5 pl-2">
              <li>洪水リスク: 25%</li>
              <li>地震リスク: 25%</li>
              <li>火災リスク: 20%</li>
              <li>高齢化リスク: 15%</li>
              <li>避難所余裕度: 15%</li>
            </ul>
          </div>
        </section>

        {/* 免責事項 */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">免責事項</h2>
          <div className="space-y-2 text-xs text-gray-500 leading-relaxed">
            <p>
              本サービスが提供する情報は、防災意識の向上を目的としたものであり、
              情報の正確性・完全性・最新性を保証するものではありません。
            </p>
            <p>
              実際の避難判断・防災対策については、必ずお住まいの自治体や
              国土交通省・消防庁・気象庁などの公的機関が発信する情報をご確認ください。
            </p>
            <p>
              本サービスの利用により生じた損害について、当サービスは一切の責任を負いません。
            </p>
          </div>
        </section>

        {/* 公的防災情報へのリンク */}
        <section className="bg-blue-50 border border-blue-100 rounded-2xl p-5 space-y-3">
          <h2 className="font-bold text-blue-800 text-sm">公的な防災情報を確認する</h2>
          <div className="space-y-2">
            {[
              { label: "国土交通省 ハザードマップポータル", note: "洪水・土砂・高潮リスクを地図で確認" },
              { label: "気象庁 地震・火山情報", note: "最新の地震・火山情報" },
              { label: "内閣府 防災情報のページ", note: "総合的な防災情報" },
              { label: "お住まいの自治体の公式サイト", note: "地域のハザードマップ・避難所情報" },
            ].map((link) => (
              <div key={link.label} className="bg-white rounded-xl p-3 border border-blue-100">
                <p className="text-sm font-medium text-blue-800">{link.label}</p>
                <p className="text-xs text-blue-600">{link.note}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 広告枠 */}
        <AdPlaceholder label="広告" className="h-24" />

        {/* フッター */}
        <footer className="text-center text-xs text-gray-400 space-y-1 pb-4">
          <p>© 2025 全国防災偏差値</p>
          <p>防災情報は必ず各自治体・公的機関の情報も合わせてご確認ください</p>
        </footer>
      </div>
    </div>
  );
}
