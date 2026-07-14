#!/usr/bin/env python3
"""
score-liquefaction-v1-all.py — 全国47都道府県 liquefaction-v1 スコア算出（単一CSV読み込み版）

処理フロー:
  Phase A: J-SHIS CSV を1回だけ読み込み、全メッシュをnumpy配列に格納
           (JCODE=0 はスキップ、JCODE=22 は水域として別途カウント)
  Phase B: 都道府県ごとに:
           1. N03 読み込み → BBox取得 + 自治体ポリゴン
           2. numpy BBox フィルタで対象メッシュを高速抽出
           3. GeoDataFrame 作成 → sjoin（within）で自治体付与
           4. 自治体別スコア算出 → by-pref JSON 即時書き出し
  Merge:   全 by-pref/ を結合 → municipalities.json で補完 → 最終 JSON 書き出し

データソース:
  防災科学技術研究所（NIED）J-SHIS 250mメッシュ微地形区分マップ 2020年版
  若松加来・松岡昌志（2020）

Usage:
  .venv-flood/bin/python3 scripts/scoring/score-liquefaction-v1-all.py [options]

Options:
  --pref-list 12 13 ...  処理する都道府県コードを指定
  --pref-start CODE      開始都道府県コード（デフォルト: 01）
  --pref-end   CODE      終了都道府県コード（デフォルト: 47）
  --skip-existing        by-pref/ に結果があればスキップ
  --merge-only           スコア計算なし、by-pref/ 結合のみ
  --output PATH          最終出力先（デフォルト: data/processed/liquefaction-scores.json）
  --strict               未知 JCODE で失敗

Examples:
  # 千葉県テスト
  .venv-flood/bin/python3 scripts/scoring/score-liquefaction-v1-all.py --pref-list 12

  # 全国処理（スキップあり再開）
  .venv-flood/bin/python3 scripts/scoring/score-liquefaction-v1-all.py --skip-existing

  # 結合のみ
  .venv-flood/bin/python3 scripts/scoring/score-liquefaction-v1-all.py --merge-only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import zipfile
from collections import Counter
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Import from score-liquefaction-v1.py (hyphenated filename → importlib)
# ---------------------------------------------------------------------------

def _load_v1_module():
    """Load score-liquefaction-v1.py as 'score_liquefaction_v1' via importlib."""
    import importlib.util
    _src = Path(__file__).parent / "score-liquefaction-v1.py"
    _spec = importlib.util.spec_from_file_location("score_liquefaction_v1", _src)
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules["score_liquefaction_v1"] = _mod
    _spec.loader.exec_module(_mod)
    return _mod


_v1 = _load_v1_module()

LIQUEFACTION_TERRAIN_RISK_BY_JCODE = _v1.LIQUEFACTION_TERRAIN_RISK_BY_JCODE
JCODE_NAMES                         = _v1.JCODE_NAMES
WATER_JCODES                        = _v1.WATER_JCODES
LIQUEFACTION_SOURCE                 = _v1.LIQUEFACTION_SOURCE
CALC_VERSION                        = _v1.CALC_VERSION
HIGH_RISK_THRESHOLD                 = _v1.HIGH_RISK_THRESHOLD
SUSCEPTIBLE_THRESHOLD               = _v1.SUSCEPTIBLE_THRESHOLD
METRIC_CRS                          = _v1.METRIC_CRS
CSV_NAME_IN_ZIP                     = _v1.CSV_NAME_IN_ZIP

mesh_to_latlon   = _v1.mesh_to_latlon
compute_score    = _v1.compute_score
find_jis_col     = _v1.find_jis_col
load_shp_from_zip = _v1.load_shp_from_zip
_make_row        = _v1._make_row
validate         = _v1.validate

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_PREFS = ["{:02d}".format(i) for i in range(1, 48)]

RAW_N03   = Path("data/raw/flood/N03")
CSV_ZIP   = Path("data/raw/liquefaction/Z-WM2020-JAPAN-M250.zip")
BY_PREF   = Path("data/processed/liquefaction/by-pref")
MUNI_JSON = Path("src/data/municipalities.json")

VALID_STATUSES = frozenset([
    "scored",
    "no-liquefaction-risk",
    "no-liquefaction-area",
    "not-processed",
])
JIS_DIGITS = frozenset("0123456789")


# ---------------------------------------------------------------------------
# Phase A: Read CSV once into numpy arrays
# ---------------------------------------------------------------------------

def read_csv_all(zip_path: Path, strict: bool = False):
    """
    全CSVを読み込み numpy 配列に格納。
    JCODE=0 は完全スキップ。JCODE=22 は水域として含める。

    Returns:
        lats       : numpy float32 array of centroid latitudes
        lons       : numpy float32 array of centroid longitudes
        jcodes     : numpy int16 array of JCODE values
        stats      : dict with total/invalid/water counts
    """
    import numpy as np

    print("Phase A: Reading CSV: {}".format(zip_path), flush=True)
    t0 = time.time()

    lat_list = []
    lon_list = []
    jcode_list = []

    total_read = 0
    invalid_coord = 0
    water_count = 0  # JCODE==22
    skipped_zero = 0
    unknown_jcodes: Counter = Counter()

    with zipfile.ZipFile(zip_path) as z:
        with z.open(CSV_NAME_IN_ZIP) as f:
            for line in f:
                line_str = line.decode("utf-8", errors="replace").strip()
                if not line_str or line_str.startswith("#"):
                    continue
                parts = [p.strip() for p in line_str.split(",")]
                if len(parts) < 2:
                    continue

                code = parts[0]
                try:
                    jcode = int(parts[1])
                except ValueError:
                    continue

                # JCODE=0: skip entirely
                if jcode == 0:
                    skipped_zero += 1
                    total_read += 1
                    continue

                total_read += 1

                if jcode not in LIQUEFACTION_TERRAIN_RISK_BY_JCODE:
                    unknown_jcodes[jcode] += 1
                    if strict:
                        raise ValueError("Unknown JCODE: {}".format(jcode))
                    continue

                latlon = mesh_to_latlon(code)
                if latlon is None:
                    invalid_coord += 1
                    continue

                lat, lon = latlon
                lat_list.append(lat)
                lon_list.append(lon)
                jcode_list.append(jcode)

                if jcode == 22:
                    water_count += 1

    elapsed = time.time() - t0
    n = len(lat_list)
    print(
        "  読み込み完了: {:,} メッシュ (うち水域JCODE22={:,}) [{:.1f}秒]".format(
            n, water_count, elapsed
        ),
        flush=True,
    )
    if invalid_coord > 0:
        print("  [warn] 座標変換失敗: {:,} 件".format(invalid_coord), file=sys.stderr)
    if unknown_jcodes:
        print("  [warn] 未知JCODE: {}".format(dict(unknown_jcodes)), file=sys.stderr)

    lats   = None
    lons   = None
    jcodes = None
    if n > 0:
        import numpy as np
        lats   = np.array(lat_list,   dtype="float32")
        lon_arr = np.array(lon_list,  dtype="float32")
        jcodes = np.array(jcode_list, dtype="int16")
        lons = lon_arr

    stats = {
        "totalMeshCount":        total_read,
        "validLandMeshCount":    n - water_count,
        "excludedWaterMeshCount": water_count,
        "invalidCoordinateCount": invalid_coord,
        "unknownJcodeCount":     sum(unknown_jcodes.values()),
    }

    return lats, lons, jcodes, stats


# ---------------------------------------------------------------------------
# Phase B: Process one prefecture
# ---------------------------------------------------------------------------

def process_pref(
    pref: str,
    lats,
    lons,
    jcodes,
    strict: bool = False,
):
    """
    BBox フィルタ → sjoin → スコア計算。
    Returns list of entry dicts for this prefecture.
    """
    import numpy as np
    import geopandas as gpd
    from shapely.geometry import Point

    n03_zip = RAW_N03 / "N03-20240101_{}_GML.zip".format(pref)
    if not n03_zip.exists():
        print("  [warn] N03 なし: {} — スキップ".format(n03_zip), file=sys.stderr)
        return None

    # Load N03
    n03 = load_shp_from_zip(n03_zip)
    jis_col = find_jis_col(n03)

    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()

    # BBox filter (numpy, fast)
    n03_wgs84 = n03_muni.to_crs("EPSG:4326")
    bounds    = n03_wgs84.total_bounds
    lat_min = float(bounds[1]) - 0.1
    lat_max = float(bounds[3]) + 0.1
    lon_min = float(bounds[0]) - 0.1
    lon_max = float(bounds[2]) + 0.1

    mask = (
        (lats >= lat_min) & (lats <= lat_max) &
        (lons >= lon_min) & (lons <= lon_max)
    )
    pref_lats   = lats[mask]
    pref_lons   = lons[mask]
    pref_jcodes = jcodes[mask]

    print(
        "  BBox filter: {} meshes (lat[{:.2f},{:.2f}] lon[{:.2f},{:.2f}])".format(
            int(mask.sum()), lat_min, lat_max, lon_min, lon_max
        ),
        flush=True,
    )

    today = date.today().isoformat()

    if len(pref_lats) == 0:
        # No meshes — all no-liquefaction-area
        rows = []
        for _, r in name_df.iterrows():
            rows.append(_make_row(
                jisCode=str(r[jis_col]),
                prefCode=pref,
                prefName=str(r["prefecture"]),
                muniName=str(r["name"]),
                score=None,
                status="no-liquefaction-area",
                susceptibleRatio=0.0,
                highRiskRatio=0.0,
                maxRiskClass=None,
                terrainComposition={},
                validLandCount=0,
                totalAssignedCount=0,
                today=today,
            ))
        return rows

    # Build GeoDataFrame from filtered points
    gdf_points = gpd.GeoDataFrame(
        {"jcode": pref_jcodes.tolist()},
        geometry=[
            Point(float(lo), float(la))
            for la, lo in zip(pref_lats, pref_lons)
        ],
        crs="EPSG:4326",
    ).to_crs(METRIC_CRS)

    # Spatial join
    joined = gpd.sjoin(
        gdf_points,
        n03_muni[[jis_col, "geometry"]],
        how="left",
        predicate="within",
    )
    unassigned = int(joined[jis_col].isna().sum())
    joined = joined.dropna(subset=[jis_col])
    print(
        "  sjoin: {} matched / {} total ({} unassigned)".format(
            len(joined), len(gdf_points), unassigned
        ),
        flush=True,
    )

    # Aggregate by municipality
    rows = []
    for _, muni_row in name_df.iterrows():
        jis = str(muni_row[jis_col])
        pref_name = str(muni_row["prefecture"])
        muni_name = str(muni_row["name"])

        muni_meshes = joined[joined[jis_col] == jis]
        jcodes_list = muni_meshes["jcode"].tolist()

        (score, status, susceptible_ratio, high_risk_ratio, max_risk_jcode,
         valid_land_count, total_assigned_count) = compute_score(jcodes_list)

        # terrain composition: top-5 JCODEs by count, % of validLandMeshCount
        valid_jcodes = [j for j in jcodes_list if j not in WATER_JCODES]
        if valid_land_count > 0:
            jcode_counts = Counter(valid_jcodes)
            terrain_comp = {
                JCODE_NAMES.get(j, str(j)): round(c / valid_land_count * 100, 1)
                for j, c in jcode_counts.most_common(5)
            }
        else:
            terrain_comp = {}

        rows.append(_make_row(
            jisCode=jis,
            prefCode=pref,
            prefName=pref_name,
            muniName=muni_name,
            score=score,
            status=status,
            susceptibleRatio=round(susceptible_ratio, 4),
            highRiskRatio=round(high_risk_ratio, 4),
            maxRiskClass=max_risk_jcode,
            terrainComposition=terrain_comp,
            validLandCount=valid_land_count,
            totalAssignedCount=total_assigned_count,
            today=today,
        ))

    return rows


# ---------------------------------------------------------------------------
# Merge helpers
# ---------------------------------------------------------------------------

def load_by_pref_results():
    """by-pref/ の全ファイルを結合して返す。"""
    rows = []
    for p in sorted(BY_PREF.glob("liquefaction-??.json")):
        with open(p, encoding="utf-8") as f:
            payload = json.load(f)
        data = payload.get("data", payload) if isinstance(payload, dict) else payload
        rows.extend(data)
    return rows


def supplement_with_muni(rows):
    """municipalities.json に存在する全 jisCode を対象に not-processed を補完する。
    jisCode が 5桁でないもの（"12000" 等）はフィルタ対象外。
    """
    if not MUNI_JSON.exists():
        print("[warn] municipalities.json が見つかりません: {}".format(MUNI_JSON), file=sys.stderr)
        return rows

    muni = json.loads(MUNI_JSON.read_text(encoding="utf-8"))
    # Filter: 5-digit codes only (exclude pref-level "12000" etc.)
    muni_codes = {
        m["jisCode"] for m in muni
        if "jisCode" in m
        and len(m["jisCode"]) == 5
        and all(c in JIS_DIGITS for c in m["jisCode"])
    }

    scored_codes = {
        r["jisCode"] for r in rows
        if len(r.get("jisCode", "")) == 5
        and all(c in JIS_DIGITS for c in r["jisCode"])
    }

    today = date.today().isoformat()
    supplement = []
    for code in sorted(muni_codes - scored_codes):
        supplement.append({
            "jisCode":                          code,
            "prefectureCode":                   code[:2],
            "prefectureName":                   None,
            "municipalityName":                 None,
            "liquefactionRiskCandidate":        None,
            "liquefactionDataStatus":           "not-processed",
            "liquefactionSusceptibleAreaRatio": None,
            "liquefactionHighRiskAreaRatio":    None,
            "liquefactionMaxRiskClass":         None,
            "liquefactionUpdatedAt":            today,
            "liquefactionSource":               LIQUEFACTION_SOURCE,
            "liquefactionMethod":               "jshis-mesh-terrain",
            "terrainComposition":               {},
            "validLandMeshCount":               None,
            "totalAssignedMeshCount":           None,
            "calculationVersion":               CALC_VERSION,
        })

    if supplement:
        print("  not-processed 補完: {}件".format(len(supplement)))

    return rows + supplement


def build_global_stats(all_rows, csv_stats):
    """グローバル統計を集計する。"""
    status_cnt = Counter(r.get("liquefactionDataStatus") for r in all_rows)
    total = len(all_rows)
    return {
        "total":                  total,
        "scored":                 status_cnt.get("scored", 0),
        "no-liquefaction-risk":   status_cnt.get("no-liquefaction-risk", 0),
        "no-liquefaction-area":   status_cnt.get("no-liquefaction-area", 0),
        "not-processed":          status_cnt.get("not-processed", 0),
        "not-found":              status_cnt.get("not-found", 0),
        "unknownJcodeCount":      csv_stats.get("unknownJcodeCount", 0),
        "invalidCoordinateCount": csv_stats.get("invalidCoordinateCount", 0),
        "unassignedMeshCount":    0,
        "totalMeshCount":         csv_stats.get("totalMeshCount", 0),
        "validLandMeshCount":     csv_stats.get("validLandMeshCount", 0),
        "excludedWaterMeshCount": csv_stats.get("excludedWaterMeshCount", 0),
    }


# ---------------------------------------------------------------------------
# Resolve prefecture list
# ---------------------------------------------------------------------------

def resolve_prefs(pref_list, pref_start, pref_end):
    if pref_list:
        return [p.zfill(2) for p in pref_list]
    start = int(pref_start) if pref_start else 1
    end   = int(pref_end)   if pref_end   else 47
    return ["{:02d}".format(i) for i in range(start, end + 1)]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="全国47都道府県 liquefaction-v1 スコア算出（単一CSV読み込み版）"
    )
    parser.add_argument("--pref-list",     nargs="+", help="処理する都道府県コードを指定")
    parser.add_argument("--pref-start",    help="開始都道府県コード（デフォルト: 01）")
    parser.add_argument("--pref-end",      help="終了都道府県コード（デフォルト: 47）")
    parser.add_argument("--skip-existing", action="store_true", help="by-pref/ に結果があればスキップ")
    parser.add_argument("--merge-only",    action="store_true", help="スコア計算なし、by-pref/ 結合のみ")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/processed/liquefaction-scores.json"),
        help="最終出力先（デフォルト: data/processed/liquefaction-scores.json）",
    )
    parser.add_argument("--strict",        action="store_true", help="未知 JCODE で失敗")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()

    csv_stats = {
        "totalMeshCount": 0,
        "validLandMeshCount": 0,
        "excludedWaterMeshCount": 0,
        "invalidCoordinateCount": 0,
        "unknownJcodeCount": 0,
    }

    lats = lons = jcodes = None

    if not args.merge_only:
        if not CSV_ZIP.exists():
            print("J-SHIS CSV ZIP が見つかりません: {}".format(CSV_ZIP), file=sys.stderr)
            print("  先に fetch-jshis-liquefaction.py を実行してください。", file=sys.stderr)
            sys.exit(1)

        # ---------------------------------------------------------------
        # Phase A: Read CSV once
        # ---------------------------------------------------------------
        lats, lons, jcodes, csv_stats = read_csv_all(CSV_ZIP, strict=args.strict)

        if lats is None:
            print("[error] CSV にメッシュが1件もありませんでした。", file=sys.stderr)
            sys.exit(1)

        # ---------------------------------------------------------------
        # Phase B: Process prefectures
        # ---------------------------------------------------------------
        prefs = resolve_prefs(args.pref_list, args.pref_start, args.pref_end)
        print("\nPhase B: Processing {} prefectures…".format(len(prefs)), flush=True)
        BY_PREF.mkdir(parents=True, exist_ok=True)

        total_prefs = len(prefs)
        for i, pref in enumerate(prefs, 1):
            out_path = BY_PREF / "liquefaction-{}.json".format(pref)

            if args.skip_existing and out_path.exists():
                print("[{}/{}] pref={} skip (既存: {})".format(i, total_prefs, pref, out_path.name))
                continue

            n03_zip = RAW_N03 / "N03-20240101_{}_GML.zip".format(pref)
            if not n03_zip.exists():
                print(
                    "[{}/{}] pref={} [warn] N03 なし: {} — スキップ".format(
                        i, total_prefs, pref, n03_zip
                    )
                )
                continue

            print(
                "\n[{}/{}] pref={} 処理中…".format(i, total_prefs, pref),
                flush=True,
            )
            t0 = time.time()

            rows = process_pref(pref, lats, lons, jcodes, strict=args.strict)
            elapsed = time.time() - t0

            if rows is None:
                continue

            errors = validate(rows)
            if errors:
                for e in errors[:5]:
                    print("  [ERROR] {}".format(e), file=sys.stderr)
                print("  → バリデーション失敗 (pref={})".format(pref), file=sys.stderr)
                continue

            payload = {
                "metadata": {
                    "prefCode":    pref,
                    "calcVersion": CALC_VERSION,
                    "generatedAt": date.today().isoformat(),
                    "elapsedSec":  round(elapsed, 1),
                },
                "data": rows,
            }
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            print(
                "  saved {} ({}件, {:.1f}秒)".format(out_path.name, len(rows), elapsed),
                flush=True,
            )

    # -------------------------------------------------------------------
    # Merge
    # -------------------------------------------------------------------
    print("\n--- Merge: by-pref/ 結合 ---", flush=True)
    all_rows = load_by_pref_results()
    print("  by-pref/ 合計: {}件".format(len(all_rows)))

    # Filter out non-5-digit codes (e.g. "12000")
    all_rows = [
        r for r in all_rows
        if len(r.get("jisCode", "")) == 5 and all(c in JIS_DIGITS for c in r["jisCode"])
    ]
    print("  5桁コードのみ: {}件".format(len(all_rows)))

    all_rows = supplement_with_muni(all_rows)
    print("  補完後合計: {}件".format(len(all_rows)))

    stats = build_global_stats(all_rows, csv_stats)

    output_payload = {
        "metadata": {
            "generatedAt": date.today().isoformat(),
            "version":     CALC_VERSION,
            "source":      LIQUEFACTION_SOURCE,
            "method":      "jshis-mesh-terrain-centroid",
            "stats":       stats,
        },
        "entries": all_rows,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output_payload, f, ensure_ascii=False, indent=2)
    print("書き出し完了: {} ({}件)".format(args.output, len(all_rows)), flush=True)

    # Summary
    print("\n=== Summary ===")
    print("  total              : {}".format(stats["total"]))
    print("  scored             : {}".format(stats["scored"]))
    print("  no-liquefaction-risk: {}".format(stats["no-liquefaction-risk"]))
    print("  no-liquefaction-area: {}".format(stats["no-liquefaction-area"]))
    print("  not-processed      : {}".format(stats["not-processed"]))
    print("  totalMeshCount     : {:,}".format(stats["totalMeshCount"]))
    print("  validLandMeshCount : {:,}".format(stats["validLandMeshCount"]))
    print("  excludedWaterMesh  : {:,}".format(stats["excludedWaterMeshCount"]))


if __name__ == "__main__":
    main()
