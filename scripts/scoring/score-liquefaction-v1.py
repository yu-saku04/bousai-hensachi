#!/usr/bin/env python3
"""
score-liquefaction-v1.py — J-SHIS 250mメッシュ微地形区分 → 液状化リスクスコア算出

データソース:
  防災科学技術研究所（NIED）J-SHIS 250mメッシュ微地形区分マップ 2020年版
  若松加来・松岡昌志（2020）
  URL: https://www.j-shis.bosai.go.jp/labs/wm2020/

スコア仕様（0〜100 / 高いほど安全）:
  JCODE別に危険度重み（0-100スケール）を付与し、
  有効地表面メッシュ（JCODE not in {0,22}）の面積比で加重平均し、
  score = clamp(round(100 - weighted_risk), 0, 100)

JCODE → 微地形区分 → 液状化危険度重み（0-100スケール）:
   0  : 海域/無データ      → EXCL (skip entirely)
   1  : 山地               → 0
   2  : 山麓地             → 0
   3  : 火山地             → 0
   4  : 火山山麓地         → 0
   5  : 丘陵               → 0
   6  : 台地（礫質）       → 0
   7  : 台地（ローム）     → 0
   8  : 台地（未分類）     → 0
   9  : 扇状地             → 25
  10  : 砂礫質低地         → 30
  11  : 自然堤防           → 55
  12  : 旧河道             → 90
  13  : 後背湿地           → 75
  14  : 三角州・海岸低地   → 80
  15  : 低地（一般）       → 45
  16  : 干拓地             → 95
  17  : 埋立地             → 100
  18  : 砂丘               → 40
  19  : 砂州・浜堤         → 65
  20  : 河原               → 40
  21  : 礫地               → 0
  22  : 湖沼               → EXCL (exclude from valid land count)
  23  : 高水敷             → 35
  24  : 岩礁               → 0

WATER_JCODES = {0, 22}
  JCODE 0: skip entirely (not read)
  JCODE 22: assign to municipality but exclude from valid land denominator

250mメッシュコード（10桁）→ 緯度経度変換:
  CODE = PP(2) + UU(2) + q(1) + v(1) + r(1) + s(1) + t(1) + u(1)
  lat = PP/1.5 + q*(5/60) + r*(5/600) + (t-1+0.5)*(5/2400)
  lon = (UU+100) + v*(1/8) + s*(1/80) + (u-1+0.5)*(1/320)
  q,v,r,s: 0-indexed  t,u: 1-indexed (1-4)

Usage:
  .venv-flood/bin/python3 scripts/scoring/score-liquefaction-v1.py \\
      --pref 12 \\
      --output data/processed/liquefaction-sample-12.json

  --pref   CODE  2桁県コード（N03ファイルを data/raw/flood/N03/ から自動解決）
  --csv    PATH  J-SHIS CSVへのパス（ZIPのまま可）
  --n03    PATH  N03 GML ZIP
  --output PATH  出力JSONパス
  --force        既存出力を上書き
  --dry-run      スコア計算のみ（ファイル出力なし）
  --inspect-csv  JCODE分布確認のみ
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from collections import Counter
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_CSV_ZIP   = Path("data/raw/liquefaction/Z-WM2020-JAPAN-M250.zip")
CSV_NAME_IN_ZIP   = "Z-WM2020-JAPAN-M250/Z-WM2020-JAPAN-M250.csv"
N03_DIR           = Path("data/raw/flood/N03")
OUT_DIR           = Path("data/processed")

LIQUEFACTION_SOURCE = (
    "防災科学技術研究所（NIED）J-SHIS 250mメッシュ微地形区分データ（若松・松岡、2020）"
)
CALC_VERSION = "liquefaction-v1"
METRIC_CRS   = "EPSG:6690"

# WATER_JCODES: JCODE 0 = skip entirely; JCODE 22 = assign but exclude from valid land count
WATER_JCODES: frozenset = frozenset({0, 22})

# Thresholds (0-100 scale)
HIGH_RISK_THRESHOLD   = 75   # risk weight >= 75 → high risk
SUSCEPTIBLE_THRESHOLD = 1    # risk weight >= 1  → susceptible

# JCODE → 液状化危険度重み（0-100スケール）
# JCODE 0 and 22 are excluded from valid land computation (see WATER_JCODES)
LIQUEFACTION_TERRAIN_RISK_BY_JCODE: dict[int, int] = {
    0:  0,    # 海域/無データ  (EXCL – skip entirely)
    1:  0,    # 山地
    2:  0,    # 山麓地
    3:  0,    # 火山地
    4:  0,    # 火山山麓地
    5:  0,    # 丘陵
    6:  0,    # 台地（礫質）
    7:  0,    # 台地（ローム）
    8:  0,    # 台地（未分類）
    9:  25,   # 扇状地
    10: 30,   # 砂礫質低地
    11: 55,   # 自然堤防
    12: 90,   # 旧河道
    13: 75,   # 後背湿地
    14: 80,   # 三角州・海岸低地
    15: 45,   # 低地（一般）
    16: 95,   # 干拓地
    17: 100,  # 埋立地
    18: 40,   # 砂丘
    19: 65,   # 砂州・浜堤
    20: 40,   # 河原
    21: 0,    # 礫地
    22: 0,    # 湖沼 (EXCL from valid land denominator)
    23: 35,   # 高水敷
    24: 0,    # 岩礁
}

JCODE_NAMES: dict[int, str] = {
    0:  "海域/無データ",
    1:  "山地",
    2:  "山麓地",
    3:  "火山地",
    4:  "火山山麓地",
    5:  "丘陵",
    6:  "台地（礫質）",
    7:  "台地（ローム）",
    8:  "台地（未分類）",
    9:  "扇状地",
    10: "砂礫質低地",
    11: "自然堤防",
    12: "旧河道",
    13: "後背湿地",
    14: "三角州・海岸低地",
    15: "低地（一般）",
    16: "干拓地",
    17: "埋立地",
    18: "砂丘",
    19: "砂州・浜堤",
    20: "河原",
    21: "礫地",
    22: "湖沼",
    23: "高水敷",
    24: "岩礁",
}

VALID_STATUSES = frozenset([
    "scored",
    "no-liquefaction-risk",
    "no-liquefaction-area",
    "not-processed",
])

JIS_DIGITS = frozenset("0123456789")


# ---------------------------------------------------------------------------
# Mesh code → lat/lon centroid
# ---------------------------------------------------------------------------

def mesh_to_latlon(code: str):
    """10桁メッシュコードを (lat, lon) 重心に変換。
    フォーマット: PP(2) UU(2) q(1) v(1) r(1) s(1) t(1) u(1)
    q,v,r,s: 0-indexed、t,u: 1-indexed (1-4)
    Returns None for invalid codes.
    """
    if len(code) != 10:
        return None
    try:
        PP = int(code[0:2])
        UU = int(code[2:4])
        q  = int(code[4])
        v  = int(code[5])
        r  = int(code[6])
        s  = int(code[7])
        t  = int(code[8])
        u  = int(code[9])
    except ValueError:
        return None

    lat_base = PP / 1.5
    lon_base = UU + 100.0

    # 2次メッシュ (8×8)
    lat = lat_base + q * (5.0 / 60.0)
    lon = lon_base + v * (1.0 / 8.0)

    # 3次メッシュ (10×10)
    lat += r * (5.0 / 600.0)
    lon += s * (1.0 / 80.0)

    # 250mメッシュ (4×4): centroid
    lat += (t - 1 + 0.5) * (5.0 / 2400.0)
    lon += (u - 1 + 0.5) * (1.0 / 320.0)

    return lat, lon


# ---------------------------------------------------------------------------
# Score formula
# ---------------------------------------------------------------------------

def compute_score(jcodes_list):
    """
    jcodes_list: list of jcode ints (all assigned to this municipality, including JCODE 22)

    valid_land = meshes where jcode not in WATER_JCODES
    weighted_risk = sum(area_ratio * risk_weight) for each unique jcode in valid land
    score = clamp(round(100 - weighted_risk), 0, 100)

    Returns (score_or_None, status, susceptible_ratio, high_risk_ratio, max_risk_jcode,
             valid_land_count, total_assigned_count)
    """
    total_assigned = len(jcodes_list)
    valid_land = [j for j in jcodes_list if j not in WATER_JCODES]
    valid_land_count = len(valid_land)

    if valid_land_count == 0:
        return (None, "no-liquefaction-area", 0.0, 0.0, None, valid_land_count, total_assigned)

    # Aggregate by JCODE
    counts = Counter(valid_land)
    weighted_risk = 0.0
    for jcode, cnt in counts.items():
        area_ratio = cnt / valid_land_count
        risk_w = LIQUEFACTION_TERRAIN_RISK_BY_JCODE.get(jcode, 0)
        weighted_risk += area_ratio * risk_w

    score = max(0, min(100, round(100 - weighted_risk)))

    # susceptibleRatio: fraction of valid land with risk >= SUSCEPTIBLE_THRESHOLD
    susceptible_count = sum(
        cnt for jcode, cnt in counts.items()
        if LIQUEFACTION_TERRAIN_RISK_BY_JCODE.get(jcode, 0) >= SUSCEPTIBLE_THRESHOLD
    )
    susceptible_ratio = susceptible_count / valid_land_count

    # highRiskRatio: fraction of valid land with risk >= HIGH_RISK_THRESHOLD
    high_risk_count = sum(
        cnt for jcode, cnt in counts.items()
        if LIQUEFACTION_TERRAIN_RISK_BY_JCODE.get(jcode, 0) >= HIGH_RISK_THRESHOLD
    )
    high_risk_ratio = high_risk_count / valid_land_count

    # Status
    if susceptible_ratio == 0.0:
        status = "no-liquefaction-risk"
        score = 100
    else:
        status = "scored"

    # Max risk JCODE (by risk weight)
    max_risk_jcode = max(valid_land, key=lambda j: LIQUEFACTION_TERRAIN_RISK_BY_JCODE.get(j, 0))

    return (score, status, susceptible_ratio, high_risk_ratio, max_risk_jcode,
            valid_land_count, total_assigned)


# ---------------------------------------------------------------------------
# CSV reading
# ---------------------------------------------------------------------------

def load_csv_for_bbox(
    zip_path: Path,
    lat_min: float, lat_max: float,
    lon_min: float, lon_max: float,
):
    """指定バウンディングボックス内のメッシュを読み込む。
    JCODE=0 は完全スキップ。JCODE=22 は含める（水域として扱う）。
    Returns: list of (lat, lon, jcode)
    """
    points = []
    skipped_invalid = 0

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

                # JCODE=0 (海域/無データ): skip entirely
                if jcode == 0:
                    continue

                latlon = mesh_to_latlon(code)
                if latlon is None:
                    skipped_invalid += 1
                    continue

                lat, lon = latlon
                if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
                    points.append((lat, lon, jcode))

    if skipped_invalid > 0:
        print(
            "  [warn] メッシュコード変換失敗: {}件".format(skipped_invalid),
            file=sys.stderr,
        )

    return points


# ---------------------------------------------------------------------------
# N03 helpers
# ---------------------------------------------------------------------------

def load_shp_from_zip(zip_path: Path):
    """ZIPからSHP/XML/GMLを読み込む（KS-METAファイルは除外）。"""
    import geopandas as gpd

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()

    def _is_meta(name: str) -> bool:
        return name.split("/")[-1].upper().startswith("KS-META")

    for ext in (".shp", ".xml", ".gml"):
        candidates = [n for n in names if n.endswith(ext) and not _is_meta(n)]
        for candidate in candidates:
            try:
                gdf = gpd.read_file("zip://{}!{}".format(zip_path.resolve(), candidate))
                if len(gdf) > 0:
                    return gdf
            except Exception as e:
                print("  [warn] {} 読み込み失敗: {}".format(candidate, e), flush=True)

    raise RuntimeError("有効なフィーチャが見つかりません: {}".format(zip_path))


def find_jis_col(gdf) -> str:
    for c in ("N03_007", "N03_007_", "jiscode"):
        if c in gdf.columns:
            return c
    raise RuntimeError("JISコード列が見つかりません。列: {}".format(list(gdf.columns)))


def auto_n03_path(pref_code: str) -> Path:
    p = N03_DIR / "N03-20240101_{}_GML.zip".format(pref_code)
    if not p.exists():
        raise FileNotFoundError("N03 not found: {}".format(p))
    return p


# ---------------------------------------------------------------------------
# Core scoring
# ---------------------------------------------------------------------------

def compute_liquefaction_scores(
    csv_zip_path: Path,
    n03_path: Path,
    pref_code: str,
):
    """N03 + J-SHIS CSV → 自治体別スコアリスト"""
    import geopandas as gpd
    from shapely.geometry import Point

    # --- N03 読み込み ---
    print("Loading N03: {}".format(n03_path), flush=True)
    n03 = load_shp_from_zip(n03_path)
    print("  {} 行, CRS={}".format(len(n03), n03.crs))

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
    print("  自治体数: {}".format(len(n03_muni)))

    # --- BBox (WGS84) ---
    n03_wgs84 = n03_muni.to_crs("EPSG:4326")
    bounds    = n03_wgs84.total_bounds  # [minx, miny, maxx, maxy]
    lat_min = float(bounds[1]) - 0.1
    lat_max = float(bounds[3]) + 0.1
    lon_min = float(bounds[0]) - 0.1
    lon_max = float(bounds[2]) + 0.1
    print(
        "  BBox: lat[{:.3f},{:.3f}] lon[{:.3f},{:.3f}]".format(
            lat_min, lat_max, lon_min, lon_max
        ),
        flush=True,
    )

    # --- J-SHIS CSV 読み込み（BBox フィルタ）---
    print("Loading J-SHIS CSV: {}".format(csv_zip_path), flush=True)
    points = load_csv_for_bbox(csv_zip_path, lat_min, lat_max, lon_min, lon_max)
    print("  対象メッシュ数（JCODE≠0）: {}".format(len(points)))

    today = date.today().isoformat()

    if len(points) == 0:
        print("  [warn] メッシュが0件 → 全自治体 no-liquefaction-area", flush=True)
        rows = []
        for _, r in name_df.iterrows():
            rows.append(_make_row(
                jisCode=str(r[jis_col]),
                prefCode=pref_code,
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

    # --- GeoDataFrame 作成 ---
    lats   = [p[0] for p in points]
    lons   = [p[1] for p in points]
    jcodes = [p[2] for p in points]

    gdf_points = gpd.GeoDataFrame(
        {"jcode": jcodes},
        geometry=[Point(lon, lat) for lat, lon in zip(lats, lons)],
        crs="EPSG:4326",
    ).to_crs(METRIC_CRS)

    # --- 空間結合 ---
    print("空間結合（メッシュ点 → N03 自治体）実行中…", flush=True)
    joined = gpd.sjoin(
        gdf_points,
        n03_muni[[jis_col, "geometry"]],
        how="left",
        predicate="within",
    )
    joined = joined.dropna(subset=[jis_col])
    print("  結合済みメッシュ: {} 件 / {} 件".format(len(joined), len(gdf_points)))

    # Precompute name lookup
    name_lookup = {
        str(r[jis_col]): (str(r["prefecture"]), str(r["name"]))
        for _, r in name_df.iterrows()
    }

    # --- 自治体別集計 ---
    rows = []

    for _, muni_row in name_df.iterrows():
        jis = str(muni_row[jis_col])
        pref_name = str(muni_row["prefecture"])
        muni_name = str(muni_row["name"])

        muni_meshes = joined[joined[jis_col] == jis]
        jcodes_list = muni_meshes["jcode"].tolist()

        (score, status, susceptible_ratio, high_risk_ratio, max_risk_jcode,
         valid_land_count, total_assigned_count) = compute_score(jcodes_list)

        # terrain composition: top-5 JCODEs by count, as % of validLandMeshCount
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
            prefCode=pref_code,
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


def _make_row(
    jisCode: str,
    prefCode: str,
    prefName: str,
    muniName: str,
    score,
    status: str,
    susceptibleRatio: float,
    highRiskRatio: float,
    maxRiskClass,
    terrainComposition: dict,
    validLandCount: int,
    totalAssignedCount: int,
    today: str,
) -> dict:
    max_risk_name = JCODE_NAMES.get(maxRiskClass) if maxRiskClass is not None else None
    return {
        "jisCode":                          jisCode,
        "prefectureCode":                   prefCode,
        "prefectureName":                   prefName,
        "municipalityName":                 muniName,
        "liquefactionRiskCandidate":        score,
        "liquefactionDataStatus":           status,
        "liquefactionSusceptibleAreaRatio": susceptibleRatio,
        "liquefactionHighRiskAreaRatio":    highRiskRatio,
        "liquefactionMaxRiskClass":         max_risk_name,
        "liquefactionUpdatedAt":            today,
        "liquefactionSource":               LIQUEFACTION_SOURCE,
        "liquefactionMethod":               "jshis-mesh-terrain",
        "terrainComposition":               terrainComposition,
        "validLandMeshCount":               validLandCount,
        "totalAssignedMeshCount":           totalAssignedCount,
        "calculationVersion":               CALC_VERSION,
    }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate(rows: list) -> list:
    errors = []
    seen = {}

    for i, r in enumerate(rows):
        tag = "[行{}][{}]".format(i + 1, r.get("jisCode", "?"))

        jis = str(r.get("jisCode", ""))
        if len(jis) != 5 or not all(c in JIS_DIGITS for c in jis):
            errors.append("{} jisCode 5桁数字必須: {!r}".format(tag, jis))
        elif jis in seen:
            errors.append("{} jisCode 重複: 初出行{}".format(tag, seen[jis] + 1))
        else:
            seen[jis] = i

        score = r.get("liquefactionRiskCandidate")
        if score is not None:
            if not isinstance(score, int) or not (0 <= score <= 100):
                errors.append("{} liquefactionRiskCandidate 範囲外: {!r}".format(tag, score))

        status = r.get("liquefactionDataStatus")
        if status not in VALID_STATUSES:
            errors.append("{} 不正 status: {!r}".format(tag, status))

        for ratio_key in ("liquefactionSusceptibleAreaRatio", "liquefactionHighRiskAreaRatio"):
            ratio = r.get(ratio_key)
            if ratio is not None and not (0.0 <= ratio <= 1.0):
                errors.append("{} {} 範囲外: {!r}".format(tag, ratio_key, ratio))

    return errors


# ---------------------------------------------------------------------------
# Inspect
# ---------------------------------------------------------------------------

def inspect_csv(zip_path: Path) -> None:
    print("CSV検査: {}".format(zip_path))

    jcode_counter: Counter = Counter()
    total = 0

    with zipfile.ZipFile(zip_path) as z:
        with z.open(CSV_NAME_IN_ZIP) as f:
            for line in f:
                line_str = line.decode("utf-8", errors="replace").strip()
                if not line_str or line_str.startswith("#"):
                    continue
                parts = [p.strip() for p in line_str.split(",")]
                if len(parts) < 2:
                    continue
                try:
                    jcode = int(parts[1])
                except ValueError:
                    continue
                jcode_counter[jcode] += 1
                total += 1

    print("\n総メッシュ数: {:,}".format(total))
    print("ユニークJCODE数: {}".format(len(jcode_counter)))
    print("\n{:>5} {:22} {:>10} {:>6}".format("JCODE", "地形名", "メッシュ数", "危険度"))
    print("-" * 50)
    for jcode in sorted(jcode_counter.keys()):
        name  = JCODE_NAMES.get(jcode, "不明")
        count = jcode_counter[jcode]
        risk  = LIQUEFACTION_TERRAIN_RISK_BY_JCODE.get(jcode, 0)
        water = " (EXCL)" if jcode in WATER_JCODES else ""
        print("  {:>3}  {:22} {:>10,}  {:>4}{}".format(jcode, name, count, risk, water))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="J-SHIS 250mメッシュ微地形区分 → 液状化リスクスコア算出"
    )
    parser.add_argument("--pref",        help="2桁県コード（N03自動解決）")
    parser.add_argument("--csv",  type=Path, default=DEFAULT_CSV_ZIP, help="J-SHIS CSV ZIP")
    parser.add_argument("--n03",  type=Path, help="N03 GML ZIP")
    parser.add_argument("--output", type=Path, help="出力JSONパス")
    parser.add_argument("--force",      action="store_true", help="既存出力を上書き")
    parser.add_argument("--dry-run",    action="store_true", help="ファイル出力なし")
    parser.add_argument("--inspect-csv", action="store_true", help="CSV JCODE分布確認のみ")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.inspect_csv:
        inspect_csv(args.csv)
        return

    pref_code = args.pref
    if not pref_code:
        print("--pref が必要です", file=sys.stderr)
        sys.exit(1)
    pref_code = pref_code.zfill(2)

    n03_path = args.n03 or auto_n03_path(pref_code)
    csv_path = args.csv

    if not csv_path.exists():
        print("J-SHIS CSV ZIP が見つかりません: {}".format(csv_path), file=sys.stderr)
        print("  先に fetch-jshis-liquefaction.py を実行してください。", file=sys.stderr)
        sys.exit(1)

    default_out = OUT_DIR / "liquefaction-sample-{}.json".format(pref_code)
    out_path    = args.output or default_out

    if out_path.exists() and not args.force and not args.dry_run:
        print("[skip] 既存ファイル: {}  (--force で上書き)".format(out_path))
        return

    print("\n[1/4] N03 + J-SHIS CSV 読み込み & 空間結合 (pref={})…".format(pref_code), flush=True)
    rows = compute_liquefaction_scores(csv_path, n03_path, pref_code)

    print("\n[2/4] バリデーション…", flush=True)
    errors = validate(rows)
    if errors:
        for e in errors[:20]:
            print("  [ERROR] {}".format(e), file=sys.stderr)
        if len(errors) > 20:
            print("  ... and {} more errors".format(len(errors) - 20), file=sys.stderr)
        sys.exit(1)
    print("  OK ({}件)".format(len(rows)))

    print("\n[3/4] 統計…")
    scores   = [r["liquefactionRiskCandidate"] for r in rows if r["liquefactionRiskCandidate"] is not None]
    statuses = [r["liquefactionDataStatus"] for r in rows]
    status_cnt = Counter(statuses)
    print("  自治体数   : {}".format(len(rows)))
    print("  scored     : {}".format(status_cnt.get("scored", 0)))
    print("  no-risk    : {}".format(status_cnt.get("no-liquefaction-risk", 0)))
    print("  no-area    : {}".format(status_cnt.get("no-liquefaction-area", 0)))
    if scores:
        print("  score min  : {}".format(min(scores)))
        print("  score max  : {}".format(max(scores)))
        print("  score mean : {:.1f}".format(sum(scores) / len(scores)))

    print("\n先頭5件プレビュー:")
    for r in rows[:5]:
        print(
            "  [{}] score={} status={} susc={:.3f} high={:.3f}".format(
                r["jisCode"],
                r["liquefactionRiskCandidate"],
                r["liquefactionDataStatus"],
                r["liquefactionSusceptibleAreaRatio"],
                r["liquefactionHighRiskAreaRatio"],
            )
        )

    if args.dry_run:
        print("\n[4/4] [dry-run] ファイル出力スキップ")
        return

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": {
            "source":      LIQUEFACTION_SOURCE,
            "calcVersion": CALC_VERSION,
            "prefCode":    pref_code,
            "generatedAt": date.today().isoformat(),
        },
        "data": rows,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print("\n[4/4] 書き出し完了: {} ({}件)".format(out_path, len(rows)))


if __name__ == "__main__":
    main()
