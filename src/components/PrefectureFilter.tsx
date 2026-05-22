"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";

interface PrefectureFilterProps {
  prefectures: string[];
  selected: string; // "" = 全国
}

export default function PrefectureFilter({ prefectures, selected }: PrefectureFilterProps) {
  const router = useRouter();
  const selectId = useId();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (val) {
      router.push(`/ranking/${encodeURIComponent(val)}`);
    } else {
      router.push("/ranking");
    }
  }

  return (
    <div>
      <label htmlFor={selectId} className="block text-xs font-medium text-gray-500 mb-1">
        都道府県で絞り込む
      </label>
      <select
        id={selectId}
        value={selected}
        onChange={handleChange}
        className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
      >
        <option value="">全国</option>
        {prefectures.map((pref) => (
          <option key={pref} value={pref}>
            {pref}
          </option>
        ))}
      </select>
    </div>
  );
}
