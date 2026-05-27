import type { Metadata } from "next";
import Link from "next/link";
import { SCORE_ITEMS, CATEGORY_ICONS } from "@/lib/score";
import type { ScoreCategory } from "@/lib/score";
import { safeJsonLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "スコア算出方法・TEMMEI防災哲学 | 全国防災偏差値",
  description:
    "全国防災偏差値が採用するTEMMEI独自の3層防災スコアリングの考え方。物理的安全・社会回復力・感情回復力の3軸で地域防災力を評価します。",
};

const categories: ScoreCategory[] = ["physical", "social", "emotional"];

const categoryDescriptions: Record<ScoreCategory, { title: string; body: string }> = {
  physical: {
    title: "物理的安全（Physical Safety）",
    body:
      "洪水・地震・火災という「見えるリスク」を数値化します。国が公開するハザードマップや地震調査データをもとに、物理的な被害を受けにくい環境かどうかを評価します。スコアが高いほど自然災害による直接被害が少ないと推定される地域です。",
  },
  social: {
    title: "社会回復力（Social Resilience）",
    body:
      "高齢化リスク・避難所の整備状況・地域の社会支援力・インフラ回復能力の4指標から算出します。災害が起きた後に「どれだけ早く普通の生活に戻れるか」を測る指標群です。避難所が充実していても、地域の助け合い体制が弱ければ回復は遅くなります。",
  },
  emotional: {
    title: "感情回復力（Emotional Resilience）",
    body:
      "TEMMEI独自の視点。孤立リスク・子育て世帯の避難ストレス・被災後の感情回復・家族防災力という「心の防災」を評価します。物理的・社会的な安全が整っていても、人の心が折れれば復興は遅れます。感情回復力は今後の防災研究における最重要課題の一つです。",
  },
};

const faqs = [
  {
    q: "スコアはどのように算出されますか？",
    a: "各指標（洪水リスク、地震リスクなど）を0〜100でスコアリングし、項目ごとの重みに従って加重平均します。スコアが高いほど「安全・体制が整っている」状態を示します。",
  },
  {
    q: "データはどこから取得していますか？",
    a: "避難所データは国土地理院の指定避難所CSVを使用しています。洪水・地震・火災・高齢化・孤立リスク等の一部指標は、現時点では初期値・設計値を含みます。",
  },
  {
    q: "偏差値と表示していますが、通常の偏差値と異なりますか？",
    a: "本サービスの「防災偏差値」は0〜100のスコアで、厳密な統計的偏差値（平均50・標準偏差10）ではありません。わかりやすさを優先した独自指標として使用しています。",
  },
  {
    q: "Phase3の感情回復力指標はなぜ重要なのですか？",
    a: "2011年の東日本大震災以降の研究で、被災後の精神的回復が物理的復興と同等以上に重要であることが分かってきました。特に孤立・子育てストレス・家族の絆は、長期的な地域回復力に大きく影響します。",
  },
];

export default function MethodologyPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />
      <div className="mx-auto max-w-md px-4 py-6 space-y-6">
        <nav className="flex items-center justify-between text-sm">
          <Link href="/" className="text-gray-500 hover:text-blue-600 transition-colors">
            ← トップへ戻る
          </Link>
          <Link href="/sources" className="text-xs text-gray-400 hover:text-blue-600 transition-colors">
            データ出典
          </Link>
        </nav>

        <header className="space-y-2">
          <h1 className="text-xl font-extrabold text-gray-900">
            📐 スコア算出方法
          </h1>
          <p className="text-sm text-gray-600 leading-relaxed">
            全国防災偏差値は、TEMMEI独自の「3層防災スコアリング」を採用しています。単なるハザードマップの数値化にとどまらず、社会的・感情的な回復力までを統合的に評価します。
          </p>
        </header>

        {/* 3層モデル概要 */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-4">
          <h2 className="font-bold text-gray-900">3層スコアリングモデル</h2>
          {categories.map((cat) => {
            const items = SCORE_ITEMS.filter((i) => i.visible && i.category === cat);
            const desc = categoryDescriptions[cat];
            return (
              <div key={cat} className="border border-gray-100 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{CATEGORY_ICONS[cat]}</span>
                  <h3 className="font-semibold text-gray-800 text-sm">{desc.title}</h3>
                </div>
                <p className="text-xs text-gray-600 leading-relaxed">{desc.body}</p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {items.map((item) => (
                    <span
                      key={item.key}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-50 border border-gray-200 rounded-full text-xs text-gray-600"
                    >
                      {item.icon} {item.shortLabel}
                      <span className="text-gray-400 ml-0.5">
                        (w={Math.round(item.weight * 100)}%)
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </section>

        {/* カテゴリスコアの算出方法 */}
        <section className="bg-blue-50 border border-blue-100 rounded-2xl p-5 space-y-2">
          <h2 className="font-bold text-gray-900 text-sm">カテゴリスコアの算出方法</h2>
          <p className="text-xs text-gray-700 leading-relaxed">
            各カテゴリのスコアは、<strong>そのカテゴリに属する指標の単純平均</strong>で算出されます。
            例えば「物理的安全」は洪水・地震・火災リスクの3指標を単純平均した値です。
            総合防災偏差値は全指標を重み（w）に従って加重平均して算出します。
          </p>
          <div className="text-xs text-gray-500 font-mono bg-white rounded-lg px-3 py-2 border border-blue-100">
            カテゴリスコア = sum(指標スコア) / 指標数<br/>
            総合スコア = sum(指標スコア × w) / sum(w)
          </div>
        </section>

        {/* スコアの読み方 */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-gray-900">スコアの読み方</h2>
          <div className="space-y-2 text-sm">
            {[
              { range: "70〜100", label: "比較的安全", color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200", note: "リスクが低く、体制も整っている" },
              { range: "50〜69", label: "標準", color: "text-blue-600", bg: "bg-blue-50 border-blue-200", note: "全国平均的なリスクレベル" },
              { range: "30〜49", label: "注意", color: "text-amber-500", bg: "bg-amber-50 border-amber-200", note: "特定リスクへの対策強化が推奨" },
              { range: "0〜29", label: "要警戒", color: "text-red-600", bg: "bg-red-50 border-red-200", note: "早急な防災行動が必要" },
            ].map(({ range, label, color, bg, note }) => (
              <div key={range} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${bg}`}>
                <span className={`font-bold tabular-nums w-16 text-right ${color}`}>{range}</span>
                <span className={`font-semibold w-16 ${color}`}>{label}</span>
                <span className="text-xs text-gray-600">{note}</span>
              </div>
            ))}
          </div>
        </section>

        {/* TEMMEI哲学 */}
        <section className="bg-gradient-to-br from-purple-50 to-blue-50 rounded-2xl border border-purple-100 p-5 space-y-3">
          <h2 className="font-bold text-gray-900">💡 TEMMEI防災哲学</h2>
          <p className="text-sm text-gray-700 leading-relaxed">
            日本の防災は長年「物理的被害の軽減」に焦点を当ててきました。しかし近年の大規模災害の研究から、<strong>「人が心折れずに生き続けられるか」</strong>が復興の鍵であることが明らかになっています。
          </p>
          <p className="text-sm text-gray-700 leading-relaxed">
            孤立した高齢者、一人で子どもを守る親、心に傷を負った被災者——彼らを支える地域の力こそが、本当の意味での防災力です。TEMMEIは「感情防災・孤立防災」を新しいスタンダードとして提唱します。
          </p>
          <blockquote className="border-l-4 border-purple-400 pl-4 text-sm text-purple-800 italic">
            「備えとは、物資だけでなく、人と人との繋がりである」
          </blockquote>
        </section>

        {/* 全国データ化に向けた注意事項 */}
        <section className="bg-amber-50 border border-amber-100 rounded-2xl p-5 space-y-2">
          <h2 className="font-bold text-amber-800 text-sm">⚠️ スコアの相対性について</h2>
          <div className="space-y-1.5 text-xs text-amber-900 leading-relaxed">
            <p>
              <strong>全国データ投入に伴いスコアは再計算されます。</strong>
              避難所データはGSI指定避難所CSVを反映済みです。
              洪水・地震・火災・高齢化・孤立リスク等の一部指標は、現時点では初期値・設計値を含みます。
              実データが追加されるたびに全自治体のスコアが更新されます。
            </p>
            <p>
              <strong>jisCodeベースでデータを結合しています。</strong>
              5桁のJISコードを第一主キーとして安定したデータ紐付けを行います。
              jisCodeがない場合、都道府県名＋市区町村名によるフォールバック結合が発生します。
              フォールバック結合は市区町村合併・改称時に誤結合のリスクがあるため、
              実データ投入時は jisCode の整備が推奨されます。
            </p>
            <p>
              <strong>検索インデックスは4フィールドに限定しています。</strong>
              id・都道府県・市区町村名・総合スコアのみを持つ軽量インデックスを
              検索UIに使用することで、詳細データの不必要なクライアント転送を防いでいます。
            </p>
            <p>
              <strong>避難所余裕度は現行 shelter-v1 の算出です。</strong>
              現行の shelterCapacity はGSI指定避難所CSVを使った指定避難所数ベースの指標です。
              GSI指定避難所CSVには収容人数と災害種別が含まれないため、
              capacity=0 / disasterTypes=unknown はGSI仕様由来です。
              政令市行政区では、GSIデータの粒度差により市単位データ、または未投入表示になる場合があります。
              収容人数や災害種別は、将来の shelter-v2 以降または自治体オープンデータで補完予定です。
            </p>
            <p>
              スコア算出のバージョンは将来的にフィールドとして管理する予定です。
              比較する際はスコアの算出時期をご確認ください。
            </p>
          </div>
        </section>

        {/* 実データ化方針 */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
          <h2 className="font-bold text-gray-900 text-sm">📊 実データ化方針</h2>
          <div className="space-y-2 text-sm text-gray-600 leading-relaxed">
            <p>
              <strong>政府公開データを使用</strong> — 国土交通省・消防庁・防災科研・総務省統計局など、
              日本政府が公開するオープンデータを優先的に使用します。
              独自調査データは使用しません。
            </p>
            <p>
              <strong>出典を明記</strong> — 各スコアはデータソースごとに出典を記録し、
              <Link href="/sources" className="text-blue-600 hover:underline">データ出典ページ</Link>
              で公開します。スコアの根拠を誰でも確認できる透明性を重視します。
            </p>
            <p>
              <strong>公式評価ではなく独自算出</strong> — 本サービスのスコアは国または自治体による
              公式の防災評価・格付けではありません。参考値として防災意識向上に活用してください。
            </p>
            <p>
              <strong>避難所データから全国反映を開始</strong> — GSI指定避難所CSVを全国反映済みです。
              ほかのハザード・統計指標は、公的データを確認しながら段階的に実データへ置き換えます。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              "国土交通省 ハザードマップ",
              "消防庁 火災統計",
              "防災科研 J-SHIS",
              "総務省 国勢調査",
              "国土地理院 指定避難所",
            ].map((src) => (
              <span key={src} className="text-xs px-2 py-0.5 bg-gray-50 border border-gray-200 rounded-full text-gray-600">
                {src}
              </span>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-4">
          <h2 className="font-bold text-gray-900">よくある質問</h2>
          <div className="space-y-4">
            {faqs.map(({ q, a }, i) => (
              <div key={i} className="space-y-1.5">
                <p className="text-sm font-semibold text-gray-800">Q. {q}</p>
                <p className="text-sm text-gray-600 leading-relaxed">A. {a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ナビ */}
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/ranking"
            className="flex items-center justify-center py-3 rounded-xl border border-gray-200 text-sm text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            ランキングを見る
          </Link>
          <Link
            href="/"
            className="flex items-center justify-center py-3 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 transition-colors"
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
