"use client";

import { useState, useId } from "react";
import Link from "next/link";
import { buildResultPath, searchByKeyword } from "@/lib/search-index";
import { getScoreLevelColor, clampScore } from "@/lib/score";
import type { MunicipalityIndex } from "@/lib/search-index";

const MAX_KEYWORD_LENGTH = 50;
const MAX_RESULTS = 20;

export default function MunicipalitySearch() {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<MunicipalityIndex[]>([]);
  const inputId = useId();
  const resultsId = useId();

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.slice(0, MAX_KEYWORD_LENGTH);
    setKeyword(val);
    setResults(val.trim() ? searchByKeyword(val, MAX_RESULTS) : []);
  }

  const hasKeyword = keyword.trim().length > 0;
  const liveMessage = hasKeyword
    ? results.length === 0
      ? `「${keyword}」に一致する市区町村が見つかりませんでした`
      : `${results.length}件見つかりました`
    : "";
  const resultNameCounts = results.reduce<Record<string, number>>((acc, m) => {
    const key = `${m.prefecture}_${m.municipality}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 mb-1">
          市区町村名で検索
        </label>
        <input
          id={inputId}
          type="search"
          value={keyword}
          onChange={handleChange}
          placeholder="例：世田谷、大阪、札幌"
          autoComplete="off"
          maxLength={MAX_KEYWORD_LENGTH}
          aria-controls={resultsId}
          aria-label="市区町村名を入力してください"
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-300"
        />
        {keyword.length >= MAX_KEYWORD_LENGTH && (
          <p className="text-xs text-amber-500 mt-1">{MAX_KEYWORD_LENGTH}文字まで入力できます</p>
        )}
      </div>

      {/* スクリーンリーダー向け検索結果通知 */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </p>

      {hasKeyword && results.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-2" aria-hidden="true">
          「{keyword}」に一致する市区町村が見つかりませんでした
        </p>
      )}

      <ul id={resultsId} className={results.length > 0 ? "divide-y divide-gray-50 rounded-xl border border-gray-100 bg-white overflow-hidden shadow-sm" : ""}>
        {results.map((m) => {
          const path = buildResultPath(m.jisCode);
          if (!path) return null;
          const score = clampScore(m.overallScore);
          return (
            <li key={m.id}>
              <Link
                href={path}
                className="flex items-center justify-between px-4 py-3 hover:bg-blue-50 transition-colors"
              >
                <div>
                  <p className="font-semibold text-gray-800 text-sm">{m.municipality}</p>
                  <p className="text-xs text-gray-400">
                    {m.prefecture}
                    {resultNameCounts[`${m.prefecture}_${m.municipality}`] > 1 ? ` / ${m.jisCode}` : ""}
                  </p>
                </div>
                <p className={`text-lg font-extrabold tabular-nums ${getScoreLevelColor(score)}`}>
                  {score}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
