export default function ScoreLegend() {
  const items = [
    { range: "70以上", label: "比較的安全", color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200" },
    { range: "50〜69", label: "標準",       color: "text-blue-600",    bg: "bg-blue-50 border-blue-200"    },
    { range: "30〜49", label: "注意",       color: "text-amber-500",   bg: "bg-amber-50 border-amber-200"  },
    { range: "29以下", label: "要警戒",     color: "text-red-600",     bg: "bg-red-50 border-red-200"      },
  ];

  return (
    <section className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm space-y-3">
      <h2 className="font-bold text-gray-800 text-sm">スコアの見方</h2>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.range} className="flex items-center gap-3">
            <span className={`px-2 py-1 rounded-lg border text-xs font-semibold ${item.color} ${item.bg} w-16 text-center`}>
              {item.range}
            </span>
            <span className={`text-sm font-medium ${item.color}`}>{item.label}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400">
        ※ スコアは各リスク項目の安全度・余裕度を表します。高いほど安全側です。
      </p>
    </section>
  );
}
