import Link from "next/link";
import { getScoreLevelColor, getScoreLevelLabel, getScoreLevelBg, clampScore } from "@/lib/score";
import type { Municipality } from "@/types/municipality";

interface RankingListProps {
  ranking: Municipality[];
}

export default function RankingList({ ranking }: RankingListProps) {
  if (ranking.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center shadow-sm">
        <p className="text-gray-400 text-sm">該当する市区町村のデータがありません</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-50 bg-gray-50 grid grid-cols-12 text-xs text-gray-400 font-medium">
        <span className="col-span-1 text-center">順位</span>
        <span className="col-span-7 pl-3">市区町村</span>
        <span className="col-span-4 text-right">偏差値</span>
      </div>
      <ol>
        {ranking.map((m, i) => {
          const score = clampScore(m.overallScore);
          const color = getScoreLevelColor(score);
          const label = getScoreLevelLabel(score);
          const bg = getScoreLevelBg(score);
          const rank = i + 1;
          const rankEmoji = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;

          return (
            <li key={m.id} className="border-b border-gray-50 last:border-none">
              <Link
                href={`/result/${encodeURIComponent(m.prefecture)}/${encodeURIComponent(m.municipality)}`}
                className="grid grid-cols-12 items-center px-4 py-4 hover:bg-gray-50 transition-colors"
              >
                <span className="col-span-1 text-center text-sm font-bold text-gray-400">
                  {rankEmoji ?? rank}
                </span>
                <div className="col-span-7 pl-3 min-w-0">
                  <p className="font-semibold text-gray-800 text-sm truncate">{m.municipality}</p>
                  <p className="text-xs text-gray-400 truncate">{m.prefecture}</p>
                </div>
                <div className="col-span-4 text-right">
                  <div className={`inline-block px-2 py-1 rounded-lg border text-xs font-semibold ${bg} ${color}`}>
                    {score}
                  </div>
                  <p className={`text-xs mt-0.5 ${color}`}>{label}</p>
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
