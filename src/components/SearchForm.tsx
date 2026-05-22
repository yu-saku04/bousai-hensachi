"use client";

import { useState, useRef, useId } from "react";
import { useRouter } from "next/navigation";
import {
  getAllPrefecturesFromIndex,
  getMunicipalitiesByPrefectureFromIndex,
  buildResultPath,
} from "@/lib/search-index";
import MunicipalitySearch from "@/components/MunicipalitySearch";

type Tab = "select" | "keyword" | "address";

const TABS: { key: Tab; label: string }[] = [
  { key: "select",  label: "選択で探す" },
  { key: "keyword", label: "キーワード" },
  { key: "address", label: "住所・郵便番号" },
];

export default function SearchForm() {
  const router = useRouter();
  const prefectures = getAllPrefecturesFromIndex();
  const [tab, setTab] = useState<Tab>("select");
  const [selectedPref, setSelectedPref] = useState("");
  const [selectedMuni, setSelectedMuni] = useState("");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tablistId = useId();

  const municipalities = selectedPref
    ? getMunicipalitiesByPrefectureFromIndex(selectedPref)
    : [];

  function handlePrefChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedPref(e.target.value);
    setSelectedMuni("");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPref || !selectedMuni) return;
    router.push(buildResultPath(selectedPref, selectedMuni));
  }

  // roving tabindex キーボードナビゲーション
  function handleTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = (index + 1) % TABS.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (index - 1 + TABS.length) % TABS.length;
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = TABS.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    setTab(TABS[next].key);
    tabRefs.current[next]?.focus();
  }

  const panelId = (key: Tab) => `${tablistId}-panel-${key}`;
  const tabId   = (key: Tab) => `${tablistId}-tab-${key}`;

  return (
    <div className="space-y-4">
      {/* タブリスト */}
      <div
        role="tablist"
        aria-label="検索方法を選択"
        className="flex rounded-xl border border-gray-100 overflow-hidden bg-gray-50 p-1 gap-1"
      >
        {TABS.map((t, i) => (
          <button
            key={t.key}
            id={tabId(t.key)}
            ref={(el) => { tabRefs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={panelId(t.key)}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => handleTabKeyDown(e, i)}
            className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
              tab === t.key
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-400 hover:text-gray-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 選択フォーム */}
      <div
        id={panelId("select")}
        role="tabpanel"
        aria-labelledby={tabId("select")}
        hidden={tab !== "select"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="prefecture" className="block text-sm font-medium text-gray-700 mb-1">
              都道府県を選ぶ
            </label>
            <select
              id="prefecture"
              value={selectedPref}
              onChange={handlePrefChange}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="">-- 都道府県を選択 --</option>
              {prefectures.map((pref) => (
                <option key={pref} value={pref}>{pref}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="municipality" className="block text-sm font-medium text-gray-700 mb-1">
              市区町村を選ぶ
            </label>
            <select
              id="municipality"
              value={selectedMuni}
              onChange={(e) => setSelectedMuni(e.target.value)}
              disabled={municipalities.length === 0}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">
                {municipalities.length === 0 ? "先に都道府県を選んでください" : "-- 市区町村を選択 --"}
              </option>
              {municipalities.map((m) => (
                <option key={m.id} value={m.municipality}>{m.municipality}</option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={!selectedPref || !selectedMuni}
            className="w-full rounded-xl bg-blue-600 px-6 py-4 text-white font-bold text-lg shadow-md hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            診断する
          </button>
        </form>
      </div>

      {/* キーワード検索 */}
      <div
        id={panelId("keyword")}
        role="tabpanel"
        aria-labelledby={tabId("keyword")}
        hidden={tab !== "keyword"}
      >
        <MunicipalitySearch />
      </div>

      {/* 住所・郵便番号（UI準備のみ） */}
      <div
        id={panelId("address")}
        role="tabpanel"
        aria-labelledby={tabId("address")}
        hidden={tab !== "address"}
      >
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">
              住所・郵便番号で検索（準備中）
            </label>
            <input
              type="text"
              disabled
              aria-disabled="true"
              placeholder="例：150-0001 または 東京都渋谷区神宮前"
              className="w-full rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-gray-300 cursor-not-allowed"
            />
          </div>
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700">
            <p className="font-semibold mb-1">🚧 住所・郵便番号検索は近日公開予定</p>
            <p className="text-xs text-blue-600">
              国土交通省の住所データベースと連携し、郵便番号や住所テキストから市区町村を自動特定する機能を準備中です。
              現在はキーワード検索または選択からお試しください。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
