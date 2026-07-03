"""
score-tsunami-v1-all.py — 全国都道府県 tsunami-v1 スコア算出（再開可能版）

処理フロー:
  1. 都道府県ごとに A40×N03 を空間結合してスコア算出
  2. 結果を data/processed/tsunami/by-pref/tsunami-{pref}.json に即時保存
  3. 全県完了後（または --merge-only 時）に by-pref/ を結合して tsunami-scores.json を生成
  4. 最終 JSON で municipalities.json 1918 件と突合し、未処理は "not-processed" で補完

都道府県分類:
  INLAND_PREFS: 09,10,11,19,20,25,29 → no-tsunami-risk (score=100)
  A40_VERSIONS 所有県: 28 県 → A40×N03 overlay → scored / no-tsunami-data
  それ以外 (19 沿岸県): not-found → import 時に missing 扱い

A40_003 浸水深テキスト例:
  '0.3m以上 ～ 1m未満' → lower=0.3m
  '0.3m未満'           → lower=0.0m
  '10m以上 ～ 20m未満' → lower=10.0m

スコア仕様:
  depth_risk_from_lower(lower_m): 0/20/35/55/70/85/100
  score_candidate(area_ratio, max_depth_lower_m):
    combined = 0.6 * min(100, area_ratio*100) + 0.4 * drisk
    → clamp(round(100 - combined), 0, 100)
  no-tsunami-data → 100, no-tsunami-risk → 100

使い方:
  .venv-flood/bin/python scripts/scoring/score-tsunami-v1-all.py
  .venv-flood/bin/python scripts/scoring/score-tsunami-v1-all.py --skip-existing
  .venv-flood/bin/python scripts/scoring/score-tsunami-v1-all.py --merge-only
  .venv-flood/bin/python scripts/scoring/score-tsunami-v1-all.py --pref-list 08 22 46
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import urllib.request
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_PREFS = [f"{i:02d}" for i in range(1, 48)]
METRIC_CRS    = "EPSG:6690"  # JGD2011 / UTM zone 54N（全国一貫 metric CRS）
TSUNAMI_SOURCE = "国土交通省 国土数値情報 津波浸水想定データ"
CALC_VERSION   = "tsunami-v1"

# 都道府県ごとの A40 バージョン（NLFTP 提供分のみ 28 県）
A40_VERSIONS: dict[str, str] = {
    "01": "A40-17",  # 北海道
    "02": "A40-16",  # 青森
    "05": "A40-16",  # 秋田
    "06": "A40-16",  # 山形
    "08": "A40-16",  # 茨城
    "12": "A40-18",  # 千葉
    "14": "A40-16",  # 神奈川
    "17": "A40-17",  # 石川
    "21": "A40-17",  # 岐阜
    "22": "A40-16",  # 静岡
    "24": "A40-16",  # 三重
    "26": "A40-16",  # 京都
    "27": "A40-16",  # 大阪
    "28": "A40-18",  # 兵庫
    "31": "A40-18",  # 鳥取
    "32": "A40-17",  # 島根
    "34": "A40-16",  # 広島
    "35": "A40-16",  # 山口
    "36": "A40-16",  # 徳島
    "38": "A40-16",  # 愛媛
    "39": "A40-16",  # 高知
    "40": "A40-16",  # 福岡
    "41": "A40-16",  # 佐賀
    "42": "A40-16",  # 長崎
    "44": "A40-16",  # 大分
    "45": "A40-16",  # 宮崎
    "46": "A40-16",  # 鹿児島
    "47": "A40-16",  # 沖縄
}

INLAND_PREFS = frozenset(["09", "10", "11", "19", "20", "25", "29"])

VALID_STATUSES = frozenset([
    "scored", "no-tsunami-data", "no-tsunami-risk", "not-found", "not-processed",
    "ward-averaged", "missing",
])
JIS_DIGITS = frozenset("0123456789")

N03_DATE  = "20240101"
BASE_URL  = "https://nlftp.mlit.go.jp/ksj/gml/data/A40"

RAW_A40   = Path("data/raw/tsunami/A40")
RAW_N03   = Path("data/raw/flood/N03")
BY_PREF   = Path("data/processed/tsunami/by-pref")
MUNI_JSON = Path("src/data/municipalities.json")

# ---------------------------------------------------------------------------
# Depth parsing
# ---------------------------------------------------------------------------

_DEPTH_LOWER_RE = re.compile(r"(?P<lower>\d+(?:\.\d+)?)\s*(?:m|メートル)?\s*以上")
_DEPTH_EXACT_RE = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s*(?:m|メートル)?")


def parse_tsunami_depth(raw: str | None) -> float:
    if raw is None:
        return 0.0
    normalized = unicodedata.normalize("NFKC", str(raw)).strip()
    normalized = re.sub(r"\s+", "", normalized)
    if normalized == "" or normalized.lower() in {"nan", "none", "null"} or normalized in {"-", "－", "—"}:
        return 0.0

    m = _DEPTH_LOWER_RE.search(normalized)
    if m:
        return float(m.group("lower"))

    # 上限のみの階級（例: "0.3m未満"）は下限0mとして扱う。
    if "未満" in normalized or "以下" in normalized:
        return 0.0

    m = _DEPTH_EXACT_RE.fullmatch(normalized)
    return float(m.group("value")) if m else 0.0


parse_depth_lower_m = parse_tsunami_depth


# ---------------------------------------------------------------------------
# Score formula
# ---------------------------------------------------------------------------

def depth_risk_from_lower(lower_m: float) -> int:
    if lower_m <= 0:
        return 0
    if lower_m < 0.3:
        return 20
    if lower_m < 1.0:
        return 35
    if lower_m < 3.0:
        return 55
    if lower_m < 5.0:
        return 70
    if lower_m < 10.0:
        return 85
    return 100


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def score_candidate(area_ratio: float, max_depth_lower_m: float) -> int:
    area_risk = clamp(area_ratio * 100.0, 0.0, 100.0)
    drisk     = depth_risk_from_lower(max_depth_lower_m)
    combined  = 0.6 * area_risk + 0.4 * drisk
    return int(clamp(round(100.0 - combined), 0, 100))


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def a40_zip(pref: str) -> Path | None:
    """A40 ZIP を RAW_A40 から自動検出（なければ None）。"""
    ver = A40_VERSIONS.get(pref)
    if not ver:
        return None
    p = RAW_A40 / f"{ver}_{pref}_GML.zip"
    return p if p.exists() else None


def n03_zip(pref: str) -> Path:
    return RAW_N03 / f"N03-{N03_DATE}_{pref}_GML.zip"


def pref_json(pref: str) -> Path:
    return BY_PREF / f"tsunami-{pref}.json"


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_zip(url: str, dest: Path) -> str:
    """'ok' | 'skip' | 'not-found' | 'error-{code}'"""
    if dest.exists():
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
        return "ok"
    except HTTPError as e:
        tmp.unlink(missing_ok=True)
        return "not-found" if e.code == 404 else f"error-{e.code}"
    except URLError as e:
        tmp.unlink(missing_ok=True)
        return f"error-{e.reason}"
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return f"error-{e}"


def ensure_a40(pref: str) -> str:
    """A40 ZIP を確保。'ok' | 'skip' | 'not-found' | 'error-*' を返す。"""
    ver = A40_VERSIONS.get(pref)
    if not ver:
        return "not-found"
    dest = RAW_A40 / f"{ver}_{pref}_GML.zip"
    url  = f"{BASE_URL}/{ver}/{ver}_{pref}_GML.zip"
    return download_zip(url, dest)


def ensure_n03(pref: str) -> str:
    dest = n03_zip(pref)
    if dest.exists():
        return "skip"
    url = f"https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-{N03_DATE}_{pref}_GML.zip"
    return download_zip(url, dest)


# ---------------------------------------------------------------------------
# GML loading
# ---------------------------------------------------------------------------

def load_gml(zip_path: Path):
    import geopandas as gpd
    import zipfile

    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
    except zipfile.BadZipFile as e:
        raise RuntimeError(f"ZIP 破損（再DL推奨）: {zip_path} — {e}")

    def _is_meta(name: str) -> bool:
        return name.split("/")[-1].upper().startswith("KS-META")

    try:
        gdf = gpd.read_file(f"zip://{zip_path.resolve()}")
        if len(gdf) > 0:
            return gdf
        print(f"  [warn] 直接読み込み結果が空、fallback へ: {zip_path.name}", flush=True)
    except Exception as _e:
        print(f"  [warn] 直接読み込み失敗、fallback へ: {_e}", flush=True)

    for ext in (".shp", ".xml", ".gml"):
        candidates = [n for n in names if n.endswith(ext) and not _is_meta(n)]
        for cand in candidates:
            try:
                gdf = gpd.read_file(f"zip://{zip_path.resolve()}!{cand}")
                if len(gdf) > 0:
                    return gdf
            except Exception:
                pass

    raise RuntimeError(f"有効なフィーチャが見つかりません: {zip_path}")


def find_jis_col(gdf) -> str:
    for c in ("N03_007", "N03_007_", "jiscode"):
        if c in gdf.columns:
            return c
    raise RuntimeError(f"JISコード列が見つかりません。列: {list(gdf.columns)}")


# ---------------------------------------------------------------------------
# Row builder
# ---------------------------------------------------------------------------

def _source_for(status: str) -> str | None:
    return TSUNAMI_SOURCE if status in ("scored", "no-tsunami-data", "no-tsunami-risk") else None


def _make_row(
    jisCode: str,
    prefecture: str,
    municipality: str,
    score: int | None,
    status: str,
    area_ratio: float | None,
    max_depth_m: float | None,
    today: str,
) -> dict:
    return {
        "jisCode":              jisCode,
        "prefecture":           prefecture,
        "municipality":         municipality,
        "tsunamiRiskCandidate": score,
        "tsunamiDataStatus":    status,
        "tsunamiAreaRatio":     area_ratio,
        "tsunamiMaxDepthM":     max_depth_m,
        "tsunamiSource":        _source_for(status),
        "tsunamiUpdatedAt":     today,
        "calculationVersion":   CALC_VERSION,
    }


# ---------------------------------------------------------------------------
# N03 name helper
# ---------------------------------------------------------------------------

def _load_n03_names(n03_path: Path):
    n03     = load_gml(n03_path)
    jis_col = find_jis_col(n03)
    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )
    return name_df, jis_col


# ---------------------------------------------------------------------------
# Per-pref computations
# ---------------------------------------------------------------------------

def compute_pref_no_tsunami_risk(pref: str, n03_path: Path) -> list[dict]:
    """内陸県 → 全自治体 no-tsunami-risk (score=100)。"""
    print(f"  [inland] N03 から自治体リストを取得中: {n03_path.name}", flush=True)
    name_df, jis_col = _load_n03_names(n03_path)
    today = date.today().isoformat()
    rows = [
        _make_row(
            jisCode      = str(r[jis_col]),
            prefecture   = str(r.get("prefecture") or ""),
            municipality = str(r.get("name") or ""),
            score        = 100,
            status       = "no-tsunami-risk",
            area_ratio   = 0.0,
            max_depth_m  = 0.0,
            today        = today,
        )
        for _, r in name_df.iterrows()
    ]
    print(f"  [inland] {len(rows)} 件 → no-tsunami-risk", flush=True)
    return rows


def compute_pref_not_found(pref: str, n03_path: Path) -> list[dict]:
    """A40 データなし → 全自治体 not-found。"""
    print(f"  [not-found] N03 から自治体リストを取得中: {n03_path.name}", flush=True)
    name_df, jis_col = _load_n03_names(n03_path)
    today = date.today().isoformat()
    rows = [
        _make_row(
            jisCode      = str(r[jis_col]),
            prefecture   = str(r.get("prefecture") or ""),
            municipality = str(r.get("name") or ""),
            score        = None,
            status       = "not-found",
            area_ratio   = None,
            max_depth_m  = None,
            today        = today,
        )
        for _, r in name_df.iterrows()
    ]
    print(f"  [not-found] {len(rows)} 件", flush=True)
    return rows


def compute_pref(pref: str) -> list[dict]:
    """A40×N03 空間結合 → tsunami-v1 スコア算出。"""
    import geopandas as gpd
    import pandas as pd

    a40_path = a40_zip(pref)
    if a40_path is None:
        raise RuntimeError(f"pref={pref}: A40 ZIP が見つかりません")

    a40 = load_gml(a40_path)
    n03 = load_gml(n03_zip(pref))

    jis_col = find_jis_col(n03)

    # A40_003 → 浸水深下限値
    if "A40_003" in a40.columns:
        a40 = a40.copy()
        a40["depth_lower_m"] = a40["A40_003"].apply(parse_tsunami_depth)
    else:
        a40 = a40.copy()
        a40["depth_lower_m"] = 0.0
        print(f"  [warn] pref={pref}: A40_003 列が存在しません", flush=True)

    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    # 投影変換（メートル系）
    a40_m    = a40.to_crs(METRIC_CRS)
    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area

    # Spatial overlay
    joined = gpd.overlay(
        a40_m[["depth_lower_m", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area

    # 自治体別集計
    agg = joined.groupby(jis_col).agg(
        tsunami_area_m2   =("clip_area_m2",   "sum"),
        tsunami_poly_count=("clip_area_m2",   "count"),
        max_depth_lower_m =("depth_lower_m",  "max"),
    ).reset_index()

    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg, on=jis_col, how="left")
    result = result.merge(name_df, on=jis_col, how="left")

    result["tsunami_area_m2"]    = result["tsunami_area_m2"].fillna(0.0)
    result["tsunami_poly_count"] = result["tsunami_poly_count"].fillna(0).astype(int)
    result["max_depth_lower_m"]  = result["max_depth_lower_m"].fillna(0.0)
    result["tsunami_area_ratio"] = (
        result["tsunami_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

    today = date.today().isoformat()
    rows: list[dict] = []
    for _, r in result.iterrows():
        has_tsunami = int(r["tsunami_poly_count"]) > 0
        if has_tsunami:
            cand   = score_candidate(float(r["tsunami_area_ratio"]), float(r["max_depth_lower_m"]))
            status = "scored"
        else:
            cand   = score_candidate(0.0, 0.0)
            status = "no-tsunami-data"

        rows.append(_make_row(
            jisCode      = str(r[jis_col]),
            prefecture   = str(r.get("prefecture") or ""),
            municipality = str(r.get("name") or ""),
            score        = cand,
            status       = status,
            area_ratio   = round(float(r["tsunami_area_ratio"]), 6),
            max_depth_m  = round(float(r["max_depth_lower_m"]), 2),
            today        = today,
        ))

    return rows


# ---------------------------------------------------------------------------
# Per-pref runner
# ---------------------------------------------------------------------------

def run_pref(
    pref: str,
    skip_existing: bool,
    no_download: bool,
) -> str:
    """
    Returns status string:
      'done-scored' | 'done-inland' | 'done-not-found'
      | 'skipped' | 'error-{msg}'
    """
    out_path = pref_json(pref)
    if skip_existing and out_path.exists():
        print(f"[{pref}] skip (already exists: {out_path.name})", flush=True)
        return "skipped"

    today = date.today().isoformat()

    # 内陸県
    if pref in INLAND_PREFS:
        n3 = n03_zip(pref)
        if not n3.exists():
            if no_download:
                return f"error-N03 not found: {n3}"
            st = ensure_n03(pref)
            if st not in ("ok", "skip"):
                return f"error-N03 download: {st}"
        try:
            rows = compute_pref_no_tsunami_risk(pref, n3)
        except Exception as e:
            return f"error-{e}"
        _save(out_path, rows)
        return "done-inland"

    # A40 データあり → spatial overlay
    if pref in A40_VERSIONS:
        a40_path = a40_zip(pref)
        if a40_path is None:
            if no_download:
                return f"error-A40 not downloaded: pref={pref}"
            st = ensure_a40(pref)
            if st not in ("ok", "skip"):
                return f"error-A40 download: {st}"
            a40_path = a40_zip(pref)

        n3 = n03_zip(pref)
        if not n3.exists():
            if no_download:
                return f"error-N03 not found: {n3}"
            st = ensure_n03(pref)
            if st not in ("ok", "skip"):
                return f"error-N03 download: {st}"

        try:
            rows = compute_pref(pref)
        except Exception as e:
            return f"error-{e}"
        _save(out_path, rows)
        return "done-scored"

    # A40 データなし（沿岸県だが NLFTP に不在）
    n3 = n03_zip(pref)
    if not n3.exists():
        if no_download:
            return f"error-N03 not found: {n3}"
        st = ensure_n03(pref)
        if st not in ("ok", "skip"):
            return f"error-N03 download: {st}"
    try:
        rows = compute_pref_not_found(pref, n3)
    except Exception as e:
        return f"error-{e}"
    _save(out_path, rows)
    return "done-not-found"


def _save(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  → saved {path.name} ({len(rows)} 件)", flush=True)


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def do_merge(output_path: Path) -> list[dict]:
    """by-pref/ を結合 → municipalities.json の not-processed を補完。"""
    pref_files = sorted(BY_PREF.glob("tsunami-*.json"))
    if not pref_files:
        print("ERROR: by-pref/ が空です。先にスコアリングを実行してください。", file=sys.stderr)
        sys.exit(1)

    all_rows: list[dict] = []
    for f in pref_files:
        rows = json.loads(f.read_text(encoding="utf-8"))
        all_rows.extend(rows)

    # municipalities.json の全 jisCode を取得
    if not MUNI_JSON.exists():
        print(f"ERROR: {MUNI_JSON} が見つかりません", file=sys.stderr)
        sys.exit(1)
    raw_muni = json.loads(MUNI_JSON.read_text(encoding="utf-8"))
    muni_codes = {m["jisCode"] for m in raw_muni}

    scored_codes = {r["jisCode"] for r in all_rows}
    missing_codes = muni_codes - scored_codes
    today = date.today().isoformat()

    # not-processed: municipalities.json にあるが N03 に存在しないコード（政令市市全体）
    for code in sorted(missing_codes):
        all_rows.append(_make_row(
            jisCode      = code,
            prefecture   = "",
            municipality = "",
            score        = None,
            status       = "not-processed",
            area_ratio   = None,
            max_depth_m  = None,
            today        = today,
        ))

    print(f"\n--- merge 統計 ---")
    print(f"  by-pref ファイル数  : {len(pref_files)}")
    print(f"  総行数（結合前）    : {len(all_rows) - len(missing_codes)}")
    print(f"  not-processed 補完  : {len(missing_codes)} 件")
    print(f"  総行数（結合後）    : {len(all_rows)}")

    status_counts: dict[str, int] = {}
    for r in all_rows:
        s = r.get("tsunamiDataStatus", "?")
        status_counts[s] = status_counts.get(s, 0) + 1
    for s, c in sorted(status_counts.items()):
        print(f"    {s:20s}: {c}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(all_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = output_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {output_path} ({len(all_rows)} 件, {size_kb:.1f} KB)")
    return all_rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Tsunami ETL: score-tsunami-v1-all")
    parser.add_argument("--pref-list", nargs="+", metavar="CODE",
                        help="処理対象県コード（省略時: 全47都道府県）")
    parser.add_argument("--pref-start", metavar="N", help="開始県コード（範囲指定）")
    parser.add_argument("--pref-end",   metavar="N", help="終了県コード（範囲指定）")
    parser.add_argument("--skip-existing", action="store_true",
                        help="既存の by-pref JSON をスキップ")
    parser.add_argument("--no-download", action="store_true",
                        help="自動ダウンロードを無効化")
    parser.add_argument("--merge-only", action="store_true",
                        help="by-pref/ を結合するのみ（スコア計算なし）")
    parser.add_argument("--output", default="data/processed/tsunami-scores.json",
                        help="最終出力 JSON パス")
    args = parser.parse_args()

    output_path = Path(args.output)

    if args.merge_only:
        do_merge(output_path)
        return

    # 処理対象県の決定
    if args.pref_list:
        prefs = [p.zfill(2) for p in args.pref_list]
    elif args.pref_start or args.pref_end:
        start = int(args.pref_start) if args.pref_start else 1
        end   = int(args.pref_end)   if args.pref_end   else 47
        prefs = [f"{i:02d}" for i in range(start, end + 1)]
    else:
        prefs = ALL_PREFS

    print(f"対象: {len(prefs)} 都道府県")
    print(f"  A40 提供: {sum(1 for p in prefs if p in A40_VERSIONS)} 県")
    print(f"  内陸     : {sum(1 for p in prefs if p in INLAND_PREFS)} 県")
    print(f"  not-found: {sum(1 for p in prefs if p not in A40_VERSIONS and p not in INLAND_PREFS)} 県\n")

    results: dict[str, str] = {}
    errors: list[str] = []

    for i, pref in enumerate(prefs, 1):
        print(f"[{i}/{len(prefs)}] pref={pref} ─────────────────────────────", flush=True)
        status = run_pref(pref, args.skip_existing, args.no_download)
        results[pref] = status
        if status.startswith("error-"):
            errors.append(f"pref={pref}: {status}")
            print(f"  ❌ {status}", file=sys.stderr)
        print("", flush=True)

    # サマリー
    print("=" * 60)
    print("スコアリング完了サマリー")
    print(f"  done-scored   : {sum(1 for s in results.values() if s == 'done-scored')}")
    print(f"  done-inland   : {sum(1 for s in results.values() if s == 'done-inland')}")
    print(f"  done-not-found: {sum(1 for s in results.values() if s == 'done-not-found')}")
    print(f"  skipped       : {sum(1 for s in results.values() if s == 'skipped')}")
    print(f"  error         : {len(errors)}")
    for e in errors:
        print(f"    ❌ {e}", file=sys.stderr)

    if errors:
        sys.exit(1)

    # 全都道府県完了 or --merge-only 相当
    do_merge(output_path)


if __name__ == "__main__":
    main()
