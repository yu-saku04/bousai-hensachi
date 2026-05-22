import { getScoreLevelColor, getScoreBarColor, clampScore } from "@/lib/score";
import type { RiskItem, Municipality } from "@/types/municipality";

interface RiskCardProps {
  item: RiskItem;
  municipality: Municipality;
}

export default function RiskCard({ item, municipality }: RiskCardProps) {
  const rawScore = municipality[item.key];
  const score = clampScore(typeof rawScore === "number" ? rawScore : 0);
  const color = getScoreLevelColor(score);
  const barColor = getScoreBarColor(score);

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl" role="img" aria-label={item.label}>
          {item.icon}
        </span>
        <div>
          <p className="font-semibold text-gray-800 text-sm">{item.label}</p>
          <p className="text-xs text-gray-400">{item.description}</p>
        </div>
        <div className={`ml-auto text-2xl font-bold tabular-nums ${color}`}>{score}</div>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}
