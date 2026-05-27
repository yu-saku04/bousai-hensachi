import type { Metadata } from "next";
import Link from "next/link";
import AdPlaceholder from "@/components/AdPlaceholder";
import rawDataSources from "@/data/data-sources.json";

export const metadata: Metadata = {
  title: "データ出典・免責事項 | 全国防災偏差値",
  description:
    "全国防災偏差値で使用しているデータの出典一覧と、サービスの免責事項についてご説明します。",
};

type DataStatus = "planned" | "collected" | "converted" | "applied";

interface DataSource {
  id: string;
  name: string;
  agency: string;
  url: string;
  dataType: string;
  targetScores: string[];
  updateFrequency: string;
  licenseNote: string;
  status: DataStatus;
  lastCheckedAt: string;
  notes: string;
}

const DATA_SOURCES = rawDataSources as DataSource[];

const STATUS_CONFIG: Record<DataStatus, { label: string; color: string; bg: string }> = {
  planned:   { label: "導入予定",   color: "text-gray-500",   bg: "bg-gray-100" },
  collected: { label: "収集済",     color: "text-blue-600",   bg: "bg-blue-50" },
  converted: { label: "変換済",     color: "text-amber-600",  bg: "bg-amber-50" },
  applied:   { label: "反映済",     color: "text-emerald-600", bg: "bg-emerald-50" },
};

const SCORE_LABELS: Record<string, string> = {
  floodRisk:                    "洪水",
  earthquakeRisk:               "地震",
  fireRisk:                     "火災",
  agingRisk:                    "高齢化",
  shelterCapacity:              "避難所",
  isolationRisk:                "孤立",
  childcareStressRisk:          "子育て",
  emotionalRecoveryRisk:        "感情回復",
  socialSupportScore:           "社会支援",
  infrastructureRecoveryScore:  "インフラ",
  familyDisasterPreparedness:   "家族防災",
};

const STATUS_ORDER: DataStatus[] = ["applied", "converted", "collected", "planned"];

function groupByStatus(sources: DataSource[]): Map<DataStatus, DataSource[]> {
  const map = new Map<DataStatus, DataSource[]>();
  for (const status of STATUS_ORDER) {
    map.set(status, sources.filter((s) => s.status === status));
  }
  return map;
}

export default function SourcesPage() {
  const grouped = groupByStatus(DATA_SOURCES);
  const appliedCount   = grouped.get("applied")?.length   ?? 0;
  const convertedCount = grouped.get("converted")?.length ?? 0;
  const collectedCount = grouped.get("collected")?.length ?? 0;
  const plannedCount   = grouped.get("planned")?.length   ?? 0;
  const totalCount     = DATA_SOURCES.length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <div className="mx-auto max-w-md px-4 py-6 space-y-6">
        <nav className="flex items-center justify-between text-sm">
          <Link href="/" className="text-gray-500 hover:text-blue-600 transition-colors">
            ← トップへ戻る
          </Link>
          <Link href="/methodology" className="text-xs text-gray-400 hover:text-blue-600 transition-colors">
            算出方法
          </Link>
        </nav>

        <header>
          <h1 className="text-xl font-extrabold text-gray-900 mb-1">📋 データ出典・免責事項</h1>
          <p className="text-xs text-gray-500">
            本サービスで使用するデータの収集状況と、ご利用にあたっての注意事項です。
          </p>
        </header>

        {/* 現在のデータ状態 */}
        <section className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-2">
          <h2 className="font-bold text-amber-800 text-sm">⚠️ 現在のデータについて</h2>
          <p className="text-sm text-amber-900 leading-relaxed">
            避難所データは<strong>GSI指定避難所CSV</strong>を反映済みです。
            洪水・地震・火災・高齢化・孤立リスク等の一部指標は、現時点では初期値・設計値を含みます。
            下記の公的機関のオープンデータをもとに順次更新します。
          </p>
        </section>

        <section className="bg-blue-50 border border-blue-100 rounded-2xl p-5 space-y-2">
          <h2 className="font-bold text-blue-800 text-sm">GSI指定避難所CSVの扱い</h2>
          <div className="space-y-1.5 text-xs text-blue-900 leading-relaxed">
            <p>
              現行 shelter-v1 はGSI指定避難所CSVを使った指定避難所数ベースの指標です。
            </p>
            <p>
              GSI指定避難所CSVには収容人数と災害種別が含まれないため、
              capacity=0 / disasterTypes=unknown はGSI仕様由来です。
            </p>
            <p>
              政令市行政区では、GSIデータの粒度差により市単位データ、または未投入表示になる場合があります。
              収容人数や災害種別は、将来の shelter-v2 以降または自治体オープンデータで補完予定です。
            </p>
          </div>
        </section>

        <AdPlaceholder label="広告" className="h-16" />

        {/* データ収集状況サマリー */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 text-sm mb-3">データ収集状況（{totalCount}件）</h2>
          <div className="grid grid-cols-2 gap-2">
            {(["applied", "converted", "collected", "planned"] as DataStatus[]).map((status) => {
              const cfg   = STATUS_CONFIG[status];
              const count = grouped.get(status)?.length ?? 0;
              return (
                <div key={status} className={`rounded-xl border px-4 py-3 ${cfg.bg}`}>
                  <div className={`text-xl font-bold tabular-nums ${cfg.color}`}>{count}</div>
                  <div className={`text-xs mt-0.5 ${cfg.color}`}>{cfg.label}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 h-2 rounded-full bg-gray-100 overflow-hidden flex">
            {appliedCount > 0 && (
              <div className="bg-emerald-500 h-full" style={{ width: `${(appliedCount / totalCount) * 100}%` }} />
            )}
            {convertedCount > 0 && (
              <div className="bg-amber-400 h-full" style={{ width: `${(convertedCount / totalCount) * 100}%` }} />
            )}
            {collectedCount > 0 && (
              <div className="bg-blue-400 h-full" style={{ width: `${(collectedCount / totalCount) * 100}%` }} />
            )}
            {plannedCount > 0 && (
              <div className="bg-gray-300 h-full" style={{ width: `${(plannedCount / totalCount) * 100}%` }} />
            )}
          </div>
        </section>

        {/* データカタログ */}
        <section className="space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">データカタログ</h2>
          {STATUS_ORDER.map((status) => {
            const sources = grouped.get(status) ?? [];
            if (sources.length === 0) return null;
            const cfg = STATUS_CONFIG[status];
            return (
              <div key={status} className="space-y-2">
                <div className={`flex items-center gap-2 px-3 py-1 rounded-lg ${cfg.bg} w-fit`}>
                  <span className={`text-xs font-semibold ${cfg.color}`}>{cfg.label}</span>
                  <span className={`text-xs ${cfg.color} opacity-70`}>{sources.length}件</span>
                </div>
                {sources.map((source) => (
                  <div
                    key={source.id}
                    className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm space-y-2"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-gray-800 leading-tight">{source.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{source.agency}</p>
                      </div>
                      <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color} ${cfg.bg}`}>
                        {cfg.label}
                      </span>
                    </div>

                    {/* 対応スコア */}
                    <div className="flex flex-wrap gap-1">
                      {source.targetScores.map((score) => (
                        <span
                          key={score}
                          className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 border border-blue-100 rounded-full"
                        >
                          {SCORE_LABELS[score] ?? score}
                        </span>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-500">
                      <span>形式: {source.dataType}</span>
                      <span>更新: {source.updateFrequency}</span>
                    </div>

                    {source.notes && (
                      <p className="text-xs text-gray-400 leading-relaxed">{source.notes}</p>
                    )}

                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-300">確認: {source.lastCheckedAt}</span>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:underline"
                      >
                        公式サイト →
                      </a>
                    </div>
                    <p className="text-xs text-gray-400">{source.licenseNote}</p>
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        <AdPlaceholder label="広告" className="h-16" />

        {/* スコアについて */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-gray-800 text-sm">スコアの算出方法について</h2>
          <div className="space-y-2 text-sm text-gray-600 leading-relaxed">
            <p>
              「防災偏差値」は、当サービスが独自に設定した指標にもとづいて算出した<strong>参考値</strong>です。
            </p>
            <p>
              物理的安全・社会回復力・感情回復力の3カテゴリ・11指標を加重平均し、
              0〜100のスコアとして表示しています。
              詳細は<Link href="/methodology" className="text-blue-600 hover:underline">算出方法ページ</Link>をご覧ください。
            </p>
            <p>
              このスコアは、国または自治体による公式の防災評価・格付けではありません。
            </p>
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

        <AdPlaceholder label="広告" className="h-24" />

        <footer className="text-center text-xs text-gray-400 space-y-1 pb-4">
          <p>© 2025 全国防災偏差値</p>
          <p>防災情報は必ず各自治体・公的機関の情報も合わせてご確認ください</p>
        </footer>
      </div>
    </div>
  );
}
