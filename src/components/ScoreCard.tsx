import {
  getScoreLevelLabel,
  getScoreLevelColor,
  getScoreLevelBg,
  getScoreBarColor,
  clampScore,
} from "@/lib/score";

interface ScoreCardProps {
  score: number;
  municipalityName: string;
  prefecture: string;
}

export default function ScoreCard({ score, municipalityName, prefecture }: ScoreCardProps) {
  const safe = clampScore(score);
  const levelLabel = getScoreLevelLabel(safe);
  const levelColor = getScoreLevelColor(safe);
  const levelBg = getScoreLevelBg(safe);
  const barColor = getScoreBarColor(safe);

  return (
    <div className={`rounded-2xl border-2 p-6 ${levelBg}`}>
      <p className="text-sm text-gray-500 mb-1">{prefecture}</p>
      <h1 className="text-2xl font-bold text-gray-800 mb-4">{municipalityName}</h1>

      <div className="text-center mb-4">
        <p className="text-sm text-gray-500 mb-1">総合防災偏差値</p>
        <div className={`text-7xl font-extrabold tabular-nums ${levelColor}`}>{safe}</div>
        <div
          className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-semibold ${levelColor} bg-white bg-opacity-70`}
        >
          {levelLabel}
        </div>
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>要警戒</span>
          <span>比較的安全</span>
        </div>
        <div className="h-3 rounded-full bg-gray-200 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${barColor}`}
            style={{ width: `${safe}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>
      </div>
    </div>
  );
}
