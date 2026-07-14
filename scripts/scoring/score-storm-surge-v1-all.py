"""
score-storm-surge-v1-all.py — 全国都道府県 storm-surge-v1 スコア算出（再開可能版）

処理フロー:
  1. 都道府県ごとに A49×N03 を空間結合してスコア算出
  2. 結果を data/processed/storm-surge/by-pref/storm-surge-{pref}.json に即時保存
  3. 全県完了後（または --merge-only 時）に by-pref/ を結合して storm-surge-scores.json を生成
  4. 最終 JSON で municipalities.json 1918件と突合し、未処理は "not-processed" で補完

都道府県分類:
  INLAND_PREFS: 09,10,11,19,20,21,25,29 → no-storm-surge-risk (score=100)
  A49_VERSIONS 所有県: 15県 → A49×N03 overlay → scored / no-storm-surge-data
  それ以外の沿岸県 (24県): not-found → import 時に missing 扱い

スコア仕様:
  STORM_SURGE_DEPTH_RISK_FROM_CODE: {1:20, 2:35, 3:70, 4:85, 5:95, 6:100}
  score_candidate(area_ratio, max_depth_code):
    combined = 0.6 * clamp(area_ratio*100, 0, 100) + 0.4 * depth_risk
    → clamp(round(100 - combined), 0, 100)
  no-storm-surge-data → 100, no-storm-surge-risk → 100

使い方:
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --skip-existing
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --merge-only
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --pref-list 14 27 40
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --no-download
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_PREFS  = [f"{i:02d}" for i in range(1, 48)]
METRIC_CRS = "EPSG:6690"   # JGD2011 / UTM zone 54N
CALC_VERSION  = "storm-surge-v1"
SOURCE_BASE   = "国土交通省 国土数値情報 高潮浸水想定区域データ"

# A49 版（都道府県別年度） — NLFTP 提供15都道府県
A49_VERSIONS: dict[str, str] = {
    "02": "A49-23",  # 青森
    "12": "A49-20",  # 千葉
    "13": "A49-20",  # 東京
    "14": "A49-24",  # 神奈川
    "23": "A49-22",  # 愛知
    "24": "A49-21",  # 三重
    "27": "A49-21",  # 大阪
    "28": "A49-24",  # 兵庫
    "35": "A49-23",  # 山口
    "36": "A49-22",  # 徳島
    "37": "A49-22",  # 香川
    "40": "A49-20",  # 福岡
    "41": "A49-23",  # 佐賀
    "44": "A49-21",  # 大分
    "45": "A49-23",  # 宮崎
}

# 完全内陸県（高潮リスクなし）
# 注: 津波(A40)と異なり岐阜(21)も内陸扱い
INLAND_PREFS = frozenset(["09", "10", "11", "19", "20", "21", "25", "29"])

JIS_DIGITS = frozenset("0123456789")

VALID_STATUSES = frozenset([
    "scored", "no-storm-surge-data", "no-storm-surge-risk",
    "not-found", "not-processed", "ward-averaged", "missing",
])

N03_DATE  = "20240101"
BASE_URL  = "https://nlftp.mlit.go.jp/ksj/gml/data/A49"

RAW_A49   = Path("data/raw/storm-surge/A49")
RAW_N03   = Path("data/raw/flood/N03")
BY_PREF   = Path("data/processed/storm-surge/by-pref")
MUNI_JSON = Path("src/data/municipalities.json")


# ---------------------------------------------------------------------------
# Depth parsing (A49_003 は自由テキスト形式、A40_003 と同一フォーマット)
# ---------------------------------------------------------------------------

_DEPTH_LOWER_RE = re.compile(r"(?P<lower>\d+(?:\.\d+)?)\s*(?:m|メートル)?\s*以上")
_DEPTH_EXACT_RE = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s*(?:m|メートル)?")


def parse_storm_surge_depth(raw: str | None) -> float:
    if raw is None:
        return 0.0
    normalized = unicodedata.normalize("NFKC", str(raw)).strip()
    normalized = re.sub(r"\s+", "", normalized)
    if normalized == "" or normalized.lower() in {"nan", "none", "null"} \
            or normalized in {"-", "－", "—"}:
        return 0.0
    m = _DEPTH_LOWER_RE.search(normalized)
    if m:
        return float(m.group("lower"))
    if "未満" in normalized or "以下" in normalized:
        return 0.0
    m = _DEPTH_EXACT_RE.fullmatch(normalized)
    return float(m.group("value")) if m else 0.0


# ---------------------------------------------------------------------------
# Score formula
# ---------------------------------------------------------------------------

def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def depth_risk_storm_surge(lower_m: float) -> int:
    if lower_m < 0.3:   return 15
    if lower_m < 0.5:   return 30
    if lower_m < 1.0:   return 40
    if lower_m < 3.0:   return 55
    if lower_m < 5.0:   return 70
    if lower_m < 10.0:  return 85
    if lower_m < 20.0:  return 95
    return 100


def score_candidate(area_ratio: float, max_depth_lower_m: float) -> int:
    area_risk  = clamp(area_ratio * 100.0, 0.0, 100.0)
    depth_risk = depth_risk_storm_surge(max_depth_lower_m)
    combined   = 0.6 * area_risk + 0.4 * depth_risk
    return int(clamp(round(100.0 - combined), 0, 100))


# ---------------------------------------------------------------------------
# GML loading
# ---------------------------------------------------------------------------

def load_gml(zip_path: Path):
    import geopandas as gpd
    import zipfile as zf

    try:
        with zf.ZipFile(zip_path) as z:
            names = z.namelist()
    except zf.BadZipFile as e:
        raise RuntimeError(f"ZIP 破損: {zip_path} — {e}")

    def _is_meta(name: str) -> bool:
        return name.split("/")[-1].upper().startswith("KS-META")

    try:
        gdf = gpd.read_file(f"zip://{zip_path.resolve()}")
        if len(gdf) > 0:
            return gdf
    except Exception:
        pass

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


def find_a49_zip(pref: str) -> Path | None:
    candidates = sorted(RAW_A49.glob(f"A49-*_{pref}_GML.zip"), reverse=True)
    return candidates[0] if candidates else None


def get_version_from_path(p: Path) -> str:
    return p.stem.split("_")[0]


# ---------------------------------------------------------------------------
# Row builder
# ---------------------------------------------------------------------------

def _make_row(
    jis_code: str,
    pref_code: str,
    prefecture: str,
    name: str,
    risk_candidate: int | None,
    area_ratio: float | None,
    max_depth_m: float | None,
    status: str,
    source_str: str,
    today: str,
) -> dict:
    return {
        "jisCode":                 jis_code,
        "prefectureCode":          pref_code,
        "prefectureName":          prefecture,
        "municipalityName":        name,
        "stormSurgeRiskCandidate": risk_candidate,
        "stormSurgeAreaRatio":     area_ratio,
        "stormSurgeMaxDepthM":     max_depth_m,
        "stormSurgeDataStatus":    status,
        "stormSurgeSource":        source_str,
        "stormSurgeUpdatedAt":     today,
        "calculationVersion":      CALC_VERSION,
    }


# ---------------------------------------------------------------------------
# Prefecture-level compute functions
# ---------------------------------------------------------------------------

def compute_pref_inland(pref: str, today: str, n03_path: Path) -> list[dict]:
    """内陸県: N03 の全自治体を no-storm-surge-risk (score=100) で返す。"""
    import geopandas as gpd

    print(f"  pref={pref}: 内陸県 → no-storm-surge-risk (score=100)", flush=True)
    try:
        n03 = load_gml(n03_path)
    except Exception as e:
        print(f"  [warn] N03 読み込み失敗: {e} — pref={pref} をスキップ", flush=True)
        return []

    jis_col = find_jis_col(n03)
    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    rows = []
    for _, r in name_df.iterrows():
        rows.append(_make_row(
            jis_code       = str(r[jis_col]),
            pref_code      = pref,
            prefecture     = str(r.get("prefecture", "") or ""),
            name           = str(r.get("name", "") or ""),
            risk_candidate = 100,
            area_ratio     = 0.0,
            max_depth_m    = None,
            status         = "no-storm-surge-risk",
            source_str     = SOURCE_BASE,
            today          = today,
        ))
    return rows


def compute_pref_not_found(pref: str, today: str, n03_path: Path) -> list[dict]:
    """NLFTP 未収録沿岸県: N03 の全自治体を not-found で返す。"""
    import geopandas as gpd

    print(f"  pref={pref}: NLFTP 未収録 → not-found", flush=True)
    try:
        n03 = load_gml(n03_path)
    except Exception as e:
        print(f"  [warn] N03 読み込み失敗: {e} — pref={pref} をスキップ", flush=True)
        return []

    jis_col = find_jis_col(n03)
    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    rows = []
    for _, r in name_df.iterrows():
        rows.append(_make_row(
            jis_code       = str(r[jis_col]),
            pref_code      = pref,
            prefecture     = str(r.get("prefecture", "") or ""),
            name           = str(r.get("name", "") or ""),
            risk_candidate = None,
            area_ratio     = None,
            max_depth_m    = None,
            status         = "not-found",
            source_str     = SOURCE_BASE,
            today          = today,
        ))
    return rows


def compute_pref(pref: str, today: str, n03_path: Path, a49_path: Path) -> list[dict]:
    """A49 × N03 空間結合でスコア算出。"""
    import geopandas as gpd

    try:
        from shapely.validation import make_valid
        HAS_MAKE_VALID = True
    except ImportError:
        HAS_MAKE_VALID = False

    version_str = get_version_from_path(a49_path)
    source_str  = f"{SOURCE_BASE} {version_str}"

    print(f"  pref={pref}: A49={a49_path.name}, N03={n03_path.name}", flush=True)

    a49 = load_gml(a49_path)
    print(f"    A49: {len(a49)} ポリゴン, CRS={a49.crs}", flush=True)

    # A49_003 → 浸水深下限値 (m)
    if "A49_003" in a49.columns:
        a49 = a49.copy()
        a49["depth_lower_m"] = a49["A49_003"].apply(
            lambda v: parse_storm_surge_depth(str(v)) if v is not None else 0.0
        )
    else:
        a49 = a49.copy()
        a49["depth_lower_m"] = 0.0

    # A49 ジオメトリ修復
    inv_cnt = int((~a49.geometry.is_valid).sum())
    if inv_cnt:
        a49 = a49.copy()
        if HAS_MAKE_VALID:
            a49.loc[~a49.geometry.is_valid, "geometry"] = \
                a49.loc[~a49.geometry.is_valid, "geometry"].apply(make_valid)
        a49.loc[~a49.geometry.is_valid, "geometry"] = \
            a49.loc[~a49.geometry.is_valid, "geometry"].buffer(0)

    # null/empty 除外
    a49 = a49[~a49.geometry.isna() & ~a49.geometry.is_empty].copy()

    if a49.crs is None:
        a49 = a49.set_crs("EPSG:6668")

    # N03
    n03 = load_gml(n03_path)
    jis_col = find_jis_col(n03)
    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()

    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    a49_m    = a49.to_crs(METRIC_CRS)
    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area
    print(f"    自治体数（N03 dissolve）: {len(n03_muni)}", flush=True)

    joined = gpd.overlay(
        a49_m[["depth_lower_m", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area

    agg = joined.groupby(jis_col).agg(
        storm_surge_area_m2   =("clip_area_m2",  "sum"),
        storm_surge_poly_count=("clip_area_m2",  "count"),
        max_depth_lower_m     =("depth_lower_m", "max"),
    ).reset_index()

    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg, on=jis_col, how="left")
    result = result.merge(name_df, on=jis_col, how="left")

    result["storm_surge_area_m2"]    = result["storm_surge_area_m2"].fillna(0.0)
    result["storm_surge_poly_count"] = result["storm_surge_poly_count"].fillna(0).astype(int)
    result["max_depth_lower_m"]      = result["max_depth_lower_m"].fillna(0.0)
    result["storm_surge_area_ratio"] = (
        result["storm_surge_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

    rows: list[dict] = []
    for _, r in result.iterrows():
        jis       = str(r[jis_col])
        area_rat  = float(r["storm_surge_area_ratio"])
        poly_cnt  = int(r["storm_surge_poly_count"])
        max_depth = float(r["max_depth_lower_m"])

        has_surge = area_rat > 0 or poly_cnt > 0

        if has_surge:
            cand   = score_candidate(area_rat, max_depth)
            status = "scored"
            a_out  = round(area_rat, 6)
            d_out  = round(max_depth, 2)
        else:
            cand   = 100
            status = "no-storm-surge-data"
            a_out  = 0.0
            d_out  = None

        rows.append(_make_row(
            jis_code       = jis,
            pref_code      = pref,
            prefecture     = str(r.get("prefecture", "") or ""),
            name           = str(r.get("name", "") or ""),
            risk_candidate = cand,
            area_ratio     = a_out,
            max_depth_m    = d_out,
            status         = status,
            source_str     = source_str,
            today          = today,
        ))

    scored  = sum(1 for r in rows if r["stormSurgeDataStatus"] == "scored")
    no_data = sum(1 for r in rows if r["stormSurgeDataStatus"] == "no-storm-surge-data")
    print(f"    scored={scored} / no-data={no_data}", flush=True)
    return rows


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def do_merge(output_path: Path) -> None:
    """by-pref/ を結合し、municipalities.json と突合して storm-surge-scores.json を生成。"""
    by_pref_files = sorted(BY_PREF.glob("storm-surge-??.json"))
    if not by_pref_files:
        print(f"ERROR: by-pref ファイルが見つかりません: {BY_PREF}", file=sys.stderr)
        sys.exit(1)

    all_rows: list[dict] = []
    for f in by_pref_files:
        rows = json.loads(f.read_text(encoding="utf-8"))
        all_rows.extend(rows)

    print(f"\n--- merge 統計（by-pref 結合後）---")
    print(f"  by-pref ファイル数 : {len(by_pref_files)}")
    print(f"  総行数（結合前）   : {len(all_rows)}")

    # municipalities.json で not-processed 補完
    if not MUNI_JSON.exists():
        print(f"ERROR: {MUNI_JSON} が見つかりません", file=sys.stderr)
        sys.exit(1)

    muni_list: list[dict] = json.loads(MUNI_JSON.read_text(encoding="utf-8"))
    muni_codes = {m["jisCode"] for m in muni_list}
    scored_codes = {r["jisCode"] for r in all_rows}

    not_processed_codes = muni_codes - scored_codes
    today = date.today().isoformat()
    for code in sorted(not_processed_codes):
        all_rows.append(_make_row(
            jis_code       = code,
            pref_code      = code[:2],
            prefecture     = "",
            name           = "",
            risk_candidate = None,
            area_ratio     = None,
            max_depth_m    = None,
            status         = "not-processed",
            source_str     = SOURCE_BASE,
            today          = today,
        ))

    print(f"  not-processed 補完 : {len(not_processed_codes)} 件")
    print(f"  総行数（結合後）   : {len(all_rows)}")

    # ステータス集計
    from collections import Counter
    status_counts = Counter(r["stormSurgeDataStatus"] for r in all_rows)
    for st, cnt in sorted(status_counts.items()):
        print(f"    {st:<30s}: {cnt}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(all_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    size_kb = output_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {output_path} ({len(all_rows)} 件, {size_kb:.1f} KB)")


# ---------------------------------------------------------------------------
# Per-pref runner
# ---------------------------------------------------------------------------

def run_pref(pref: str, skip_existing: bool, no_download: bool) -> list[dict]:
    """1都道府県を処理してリストを返す。"""
    out_file = BY_PREF / f"storm-surge-{pref}.json"
    today    = date.today().isoformat()

    if skip_existing and out_file.exists():
        print(f"  [skip] pref={pref}: {out_file.name} 既存のためスキップ", flush=True)
        return json.loads(out_file.read_text(encoding="utf-8"))

    n03_path = RAW_N03 / f"N03-{N03_DATE}_{pref}_GML.zip"
    if not n03_path.exists():
        print(f"  [warn] pref={pref}: N03 ファイルなし: {n03_path}", flush=True)
        return []

    if pref in INLAND_PREFS:
        rows = compute_pref_inland(pref, today, n03_path)
    elif pref not in A49_VERSIONS:
        rows = compute_pref_not_found(pref, today, n03_path)
    else:
        a49_path = find_a49_zip(pref)
        if a49_path is None:
            if no_download:
                print(f"  [warn] pref={pref}: A49 ファイルなし、--no-download のため skip",
                      flush=True)
                return []
            print(f"  [warn] pref={pref}: A49 ファイルなし。先に fetch-nlftp-storm-surge.py を実行してください。",
                  flush=True)
            rows = compute_pref_not_found(pref, today, n03_path)
        else:
            rows = compute_pref(pref, today, n03_path, a49_path)

    BY_PREF.mkdir(parents=True, exist_ok=True)
    out_file.write_text(
        json.dumps(rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    size_kb = out_file.stat().st_size / 1024
    print(f"    → saved {out_file.name} ({len(rows)} 件, {size_kb:.1f} KB)", flush=True)
    return rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Storm Surge ETL 全国版: score-storm-surge-v1-all"
    )
    parser.add_argument("--pref-list", nargs="+", metavar="CODE",
                        help="処理対象の都道府県コード（省略時: 全47県）")
    parser.add_argument("--skip-existing", action="store_true",
                        help="by-pref/ に既存ファイルがある場合はスキップ")
    parser.add_argument("--no-download", action="store_true",
                        help="A49 ファイルがない県をスキップ（fetch しない）")
    parser.add_argument("--merge-only", action="store_true",
                        help="スコア算出をスキップして by-pref/ の結合のみ実行")
    parser.add_argument("--output", type=Path,
                        default=Path("data/processed/storm-surge-scores.json"),
                        help="出力 JSON パス")
    args = parser.parse_args()

    if args.merge_only:
        do_merge(args.output)
        return

    prefs = args.pref_list if args.pref_list else ALL_PREFS
    prefs = [p.zfill(2) for p in prefs]

    print(f"対象都道府県: {prefs}")
    print(f"skip-existing: {args.skip_existing}")
    print(f"no-download  : {args.no_download}\n")

    for pref in prefs:
        print(f"\n[pref={pref}]", flush=True)
        run_pref(pref, args.skip_existing, args.no_download)

    do_merge(args.output)


if __name__ == "__main__":
    main()
