"""
score-storm-surge-v1.py — A49×N03 空間結合 → stormSurgeRiskCandidate 算出 (PoC / pref=14)

PoC で確認した実際の A49_003 フィールド値（自由テキスト形式・整数コードではない）:
  '0.3m未満', '0.3m以上0.5m未満', '0.5m以上1m未満', '1m以上3m未満',
  '3m以上5m未満', '5m以上10m未満', '10m以上20m未満'
  ※ A40_003（津波）と同じ自由テキスト形式。parse_tsunami_depth と同一の正規化処理を適用。

スコア仕様（全スコア共通: 0〜100, 高いほど安全）:
  depth_risk_storm_surge(lower_m):
    lower_m < 0.3  → 15  (0.3m未満: 浸水区域だが浅い)
    lower_m < 0.5  → 30  (0.3m以上0.5m未満)
    lower_m < 1.0  → 40  (0.5m以上1m未満)
    lower_m < 3.0  → 55  (1m以上3m未満)
    lower_m < 5.0  → 70  (3m以上5m未満)
    lower_m < 10.0 → 85  (5m以上10m未満)
    lower_m >= 10.0 → 95  (10m以上20m未満)
    lower_m >= 20.0 → 100 (20m以上)
  ※ lower_m=0 かつ has_surge=True（0.3m未満）: depthRisk=15 として計算

  area_risk  = clamp(storm_surge_area_ratio * 100, 0, 100)
  depth_risk = depth_risk_storm_surge(max_depth_lower_m)
  combined   = 0.6 * area_risk + 0.4 * depth_risk
  score      = clamp(round(100 - combined), 0, 100)

  no-storm-surge-data → score=100, areaRatio=0, maxDepthM=null

Usage:
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1.py \\
      --pref 14 --output data/processed/storm-surge-sample-14.json
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1.py \\
      --pref 14 --output data/processed/storm-surge-sample-14.json --strict
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

METRIC_CRS   = "EPSG:6690"   # JGD2011 / UTM zone 54N（全国一貫 CRS）
CALC_VERSION = "storm-surge-v1"
SOURCE_BASE  = "国土交通省 国土数値情報 高潮浸水想定区域データ"

RAW_A49   = Path("data/raw/storm-surge/A49")
RAW_N03   = Path("data/raw/flood/N03")
MUNI_JSON = Path("src/data/municipalities.json")
N03_DATE  = "20240101"

JIS_DIGITS = frozenset("0123456789")

VALID_STATUSES = frozenset([
    "scored", "no-storm-surge-data", "no-storm-surge-risk",
    "not-processed", "not-found", "ward-averaged", "missing",
])


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def find_a49_zip(pref: str, out_dir: Path = RAW_A49) -> Path | None:
    """RAW_A49 から A49-*_{pref}_GML.zip を自動検索（最新版を返す）。"""
    candidates = sorted(out_dir.glob(f"A49-*_{pref}_GML.zip"), reverse=True)
    return candidates[0] if candidates else None


def get_version_from_path(p: Path) -> str:
    """ファイル名 'A49-24_14_GML.zip' → 'A49-24'"""
    parts = p.stem.split("_")
    return parts[0] if parts else "A49-??"


# ---------------------------------------------------------------------------
# Depth parsing
# ---------------------------------------------------------------------------

_DEPTH_LOWER_RE = re.compile(r"(?P<lower>\d+(?:\.\d+)?)\s*(?:m|メートル)?\s*以上")
_DEPTH_EXACT_RE = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s*(?:m|メートル)?")


def parse_storm_surge_depth(raw: str | None) -> float:
    """
    A49_003 テキストから浸水深下限値 (m) を返す。
    A40_003（津波）と同じ自由テキスト形式のため、同一ロジックを適用。
    '0.3m未満' → 0.0 (下限なし), '1m以上3m未満' → 1.0
    解析不能 → 0.0
    """
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

    # '0.3m未満' のような上限のみ → 下限 0m
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
    """
    高潮浸水深下限 (m) → depthRisk。
    A49_003 の実際の区分境界値に対応。
    lower_m=0 かつ has_surge=True は '0.3m未満' 区域を示すため depthRisk=15。
    """
    if lower_m < 0.3:
        return 15   # 0.3m未満（浸水区域だが浅い）
    if lower_m < 0.5:
        return 30   # 0.3m以上0.5m未満
    if lower_m < 1.0:
        return 40   # 0.5m以上1m未満
    if lower_m < 3.0:
        return 55   # 1m以上3m未満
    if lower_m < 5.0:
        return 70   # 3m以上5m未満
    if lower_m < 10.0:
        return 85   # 5m以上10m未満
    if lower_m < 20.0:
        return 95   # 10m以上20m未満
    return 100      # 20m以上


def score_storm_surge(area_ratio: float, max_depth_lower_m: float) -> int:
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
        raise RuntimeError(f"ZIP 破損（再DL推奨）: {zip_path} — {e}")

    def _is_meta(name: str) -> bool:
        return name.split("/")[-1].upper().startswith("KS-META")

    try:
        gdf = gpd.read_file(f"zip://{zip_path.resolve()}")
        if len(gdf) > 0:
            return gdf
        print(f"  [warn] 直接読み込み結果が空、fallback へ: {zip_path.name}", flush=True)
    except Exception as e:
        print(f"  [warn] 直接読み込み失敗 ({e})、fallback へ", flush=True)

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
# Core computation
# ---------------------------------------------------------------------------

def compute_storm_surge_scores(
    a49_path: Path,
    n03_path: Path,
    version_str: str,
    log_depths: bool = True,
    strict: bool = False,
) -> tuple[list[dict], dict]:
    """
    A49 × N03 空間結合でスコアを算出。
    Returns (rows, internal_stats).
    """
    import geopandas as gpd

    try:
        from shapely.validation import make_valid
        HAS_MAKE_VALID = True
    except ImportError:
        HAS_MAKE_VALID = False
        print("  [warn] shapely.validation.make_valid 不可。buffer(0) で代替します。",
              flush=True)

    internal_stats: dict[str, int] = {
        "invalidGeometryCount": 0,
        "unknownDepthCodeCount": 0,
    }
    today      = date.today().isoformat()
    source_str = f"{SOURCE_BASE} {version_str}"

    # --- A49 読み込み ---
    print(f"\nLoading A49: {a49_path}", flush=True)
    a49 = load_gml(a49_path)
    print(f"  {len(a49)} ポリゴン, CRS={a49.crs}", flush=True)
    print(f"  列: {list(a49.columns)}", flush=True)

    # A49_003 実値を必ずログ出力（PoC 必須）
    if "A49_003" in a49.columns:
        unique_vals = sorted(a49["A49_003"].dropna().unique().tolist(), key=str)
        print(f"\n--- A49_003 ユニーク値 ({len(unique_vals)}種) ---", flush=True)
        for v in unique_vals:
            lower_m = parse_storm_surge_depth(str(v))
            drisk   = depth_risk_storm_surge(lower_m)
            print(f"  {str(v)!r:30s} → 下限 {lower_m}m / depthRisk={drisk}", flush=True)
        print("", flush=True)

        # A49_003 → 浸水深下限値 (m)
        a49 = a49.copy()
        a49["depth_lower_m"] = a49["A49_003"].apply(
            lambda v: parse_storm_surge_depth(str(v)) if v is not None else 0.0
        )
    else:
        print(f"  [warn] A49_003 列が見つかりません。列: {list(a49.columns)}", flush=True)
        if strict:
            print("  [strict] A49_003 列なしのため終了します。", file=sys.stderr)
            sys.exit(1)
        a49 = a49.copy()
        a49["depth_lower_m"] = 0.0

    # --- A49 ジオメトリ品質チェック ---
    null_cnt  = int(a49.geometry.isna().sum())
    empty_cnt = int((~a49.geometry.isna() & a49.geometry.is_empty).sum())
    if null_cnt or empty_cnt:
        print(f"  [warn] null geometry: {null_cnt}件 / empty geometry: {empty_cnt}件 → 除外",
              flush=True)
        a49 = a49[~a49.geometry.isna() & ~a49.geometry.is_empty].copy()

    inv_mask = ~a49.geometry.is_valid
    inv_cnt  = int(inv_mask.sum())
    if inv_cnt > 0:
        internal_stats["invalidGeometryCount"] += inv_cnt
        print(f"  [info] invalid geometry: {inv_cnt}件 → 修復中", flush=True)
        a49 = a49.copy()
        if HAS_MAKE_VALID:
            a49.loc[inv_mask, "geometry"] = a49.loc[inv_mask, "geometry"].apply(make_valid)
        a49.loc[~a49.geometry.is_valid, "geometry"] = \
            a49.loc[~a49.geometry.is_valid, "geometry"].buffer(0)
        still_inv = int((~a49.geometry.is_valid).sum())
        if still_inv:
            print(f"  [warn] 修復後も invalid: {still_inv}件", flush=True)

    if a49.crs is None:
        print("  [warn] A49 CRS が不明。JGD2011 (EPSG:6668) を仮定します。", flush=True)
        a49 = a49.set_crs("EPSG:6668")

    # --- N03 読み込み ---
    print(f"Loading N03: {n03_path}", flush=True)
    n03 = load_gml(n03_path)
    print(f"  {len(n03)} 行, CRS={n03.crs}", flush=True)

    jis_col = find_jis_col(n03)
    print(f"  JISコード列: {jis_col}", flush=True)

    # N03 ジオメトリ修復
    n03_inv = int((~n03.geometry.is_valid).sum())
    if n03_inv > 0:
        print(f"  [info] N03 invalid geometry: {n03_inv}件 → 修復中", flush=True)
        n03 = n03.copy()
        if HAS_MAKE_VALID:
            n03.loc[~n03.geometry.is_valid, "geometry"] = \
                n03.loc[~n03.geometry.is_valid, "geometry"].apply(make_valid)
        n03.loc[~n03.geometry.is_valid, "geometry"] = \
            n03.loc[~n03.geometry.is_valid, "geometry"].buffer(0)

    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    unique_jis = sorted(n03_clean[jis_col].unique())
    print(f"  ユニーク JISコード数: {len(unique_jis)}", flush=True)

    # 名称テーブル
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    # --- CRS 変換（メートル系）---
    a49_m    = a49.to_crs(METRIC_CRS)
    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area
    print(f"  自治体数（N03 dissolve 後）: {len(n03_muni)}", flush=True)

    # --- 空間 overlay ---
    print("Spatial overlay（A49 ∩ N03）実行中…", flush=True)
    joined = gpd.overlay(
        a49_m[["depth_lower_m", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area
    print(f"  overlay 結果: {len(joined)} 行", flush=True)

    if len(joined) == 0:
        print("  [warn] overlay 結果が 0 件。A49 と N03 が空間的に重複していない可能性。",
              flush=True)

    # --- 集計 ---
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
    # 面積比: 重複ポリゴンで sum > muni_area になりうる → 1.0 でクランプ
    result["storm_surge_area_ratio"] = (
        result["storm_surge_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

    # --- rows 生成 ---
    rows: list[dict] = []
    scored_cnt  = 0
    no_data_cnt = 0

    for _, r in result.iterrows():
        jis       = str(r[jis_col])
        area_rat  = float(r["storm_surge_area_ratio"])
        poly_cnt  = int(r["storm_surge_poly_count"])
        max_depth = float(r["max_depth_lower_m"])

        has_surge = area_rat > 0 or poly_cnt > 0

        if has_surge:
            cand       = score_storm_surge(area_rat, max_depth)
            status     = "scored"
            a_out      = round(area_rat, 6)
            d_out      = round(max_depth, 2)
            scored_cnt += 1
        else:
            cand       = 100
            status     = "no-storm-surge-data"
            a_out      = 0.0
            d_out      = None
            no_data_cnt += 1

        rows.append({
            "jisCode":                 jis,
            "prefectureCode":          jis[:2],
            "prefectureName":          str(r.get("prefecture", "") or ""),
            "municipalityName":        str(r.get("name", "") or ""),
            "stormSurgeRiskCandidate": cand,
            "stormSurgeAreaRatio":     a_out,
            "stormSurgeMaxDepthM":     d_out,
            "stormSurgeDataStatus":    status,
            "stormSurgeSource":        source_str,
            "stormSurgeUpdatedAt":     today,
            "calculationVersion":      CALC_VERSION,
        })

    internal_stats["scored"]             = scored_cnt
    internal_stats["no-storm-surge-data"]= no_data_cnt

    return rows, internal_stats


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate(rows: list[dict], strict: bool = False) -> list[str]:
    errors: list[str] = []
    seen: dict[str, int] = {}

    for i, r in enumerate(rows):
        tag = f"[行{i+1}][{r.get('jisCode', '?')}]"
        jis = r.get("jisCode", "")

        if len(jis) != 5 or not all(c in JIS_DIGITS for c in jis):
            errors.append(f"{tag} jisCode 5桁数字必須: {jis!r}")
        elif jis in seen:
            errors.append(f"{tag} jisCode 重複: 初出行{seen[jis]+1}")
        else:
            seen[jis] = i

        status = r.get("stormSurgeDataStatus", "")
        if status not in VALID_STATUSES:
            errors.append(f"{tag} stormSurgeDataStatus 不正: {status!r}")

        cand  = r.get("stormSurgeRiskCandidate")
        ratio = r.get("stormSurgeAreaRatio")
        depth = r.get("stormSurgeMaxDepthM")

        if status == "scored":
            if not (isinstance(cand, int) and 0 <= cand <= 100):
                errors.append(f"{tag} scored: stormSurgeRiskCandidate 0〜100整数必須: {cand!r}")
            if not (isinstance(ratio, float) and ratio > 0):
                errors.append(f"{tag} scored: stormSurgeAreaRatio > 0 必須: {ratio!r}")
            if not isinstance(depth, float):
                errors.append(f"{tag} scored: stormSurgeMaxDepthM float 必須: {depth!r}")

        elif status == "no-storm-surge-data":
            if cand != 100:
                errors.append(f"{tag} no-storm-surge-data: score=100 必須: {cand!r}")
            if ratio != 0.0:
                errors.append(f"{tag} no-storm-surge-data: areaRatio=0 必須: {ratio!r}")
            if depth is not None:
                errors.append(f"{tag} no-storm-surge-data: maxDepthM=null 必須: {depth!r}")

        elif status in ("not-processed", "not-found", "missing"):
            if cand is not None:
                errors.append(f"{tag} {status}: score=null 必須: {cand!r}")

        elif status == "no-storm-surge-risk":
            if cand != 100:
                errors.append(f"{tag} no-storm-surge-risk: score=100 必須: {cand!r}")

        if ratio is not None and not (0.0 <= ratio <= 1.0):
            errors.append(f"{tag} stormSurgeAreaRatio: 0〜1 必須: {ratio!r}")

        if r.get("calculationVersion") != CALC_VERSION:
            errors.append(f"{tag} calculationVersion: {CALC_VERSION!r} 必須: "
                          f"{r.get('calculationVersion')!r}")

    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Storm Surge ETL PoC: score-storm-surge-v1"
    )
    parser.add_argument("--a49",    help="A49 GML ZIP path（省略時: 自動検索）")
    parser.add_argument("--n03",    help="N03 GML ZIP path（省略時: 自動解決）")
    parser.add_argument("--pref",   default="14",
                        help="2桁県コード（default: 14）")
    parser.add_argument("--muni",   default=str(MUNI_JSON),
                        help=f"municipalities.json path")
    parser.add_argument("--output", required=True, help="出力 JSON path")
    parser.add_argument("--strict", action="store_true",
                        help="検証エラー時に即終了")
    parser.add_argument("--no-log-depths", action="store_true",
                        help="A49_003 ユニーク値ログを抑制")
    args = parser.parse_args()

    pref     = args.pref.zfill(2)
    a49_path = Path(args.a49) if args.a49 else find_a49_zip(pref)

    if a49_path is None:
        print(f"ERROR: A49 ファイルが見つかりません: {RAW_A49}/A49-*_{pref}_GML.zip",
              file=sys.stderr)
        print(f"  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-storm-surge.py "
              f"--pref {pref}", file=sys.stderr)
        sys.exit(1)

    n03_path = Path(args.n03) if args.n03 else RAW_N03 / f"N03-{N03_DATE}_{pref}_GML.zip"

    for p, label in ((a49_path, "A49"), (n03_path, "N03")):
        if not p.exists():
            print(f"ERROR: {label} ファイルが見つかりません: {p}", file=sys.stderr)
            sys.exit(1)

    version_str = get_version_from_path(a49_path)
    print(f"A49 version : {version_str}")
    print(f"A49 path    : {a49_path}")
    print(f"N03 path    : {n03_path}")
    print(f"pref        : {pref}")

    # --- N03 ベーススコア計算 ---
    rows, int_stats = compute_storm_surge_scores(
        a49_path    = a49_path,
        n03_path    = n03_path,
        version_str = version_str,
        log_depths  = not args.no_log_depths,
        strict      = args.strict,
    )

    n03_jis_set = {r["jisCode"] for r in rows}

    # --- municipalities.json から not-processed を補完 ---
    muni_path = Path(args.muni)
    if not muni_path.exists():
        print(f"ERROR: {muni_path} が見つかりません", file=sys.stderr)
        sys.exit(1)

    with open(muni_path, encoding="utf-8") as f:
        all_muni: list[dict] = json.load(f)

    pref_muni_codes = [
        m["jisCode"] for m in all_muni
        if m["jisCode"].startswith(pref)
    ]
    print(f"\nmunicipalities.json pref={pref} 件数: {len(pref_muni_codes)}", flush=True)

    not_processed_codes = [c for c in pref_muni_codes if c not in n03_jis_set]
    print(f"not-processed（N03未収録）: {len(not_processed_codes)} 件", flush=True)
    if not_processed_codes:
        print(f"  → {not_processed_codes}", flush=True)

    today      = date.today().isoformat()
    source_str = f"{SOURCE_BASE} {version_str}"
    np_cnt     = 0

    for code in not_processed_codes:
        rows.append({
            "jisCode":                 code,
            "prefectureCode":          code[:2],
            "prefectureName":          "",
            "municipalityName":        "",
            "stormSurgeRiskCandidate": None,
            "stormSurgeAreaRatio":     None,
            "stormSurgeMaxDepthM":     None,
            "stormSurgeDataStatus":    "not-processed",
            "stormSurgeSource":        source_str,
            "stormSurgeUpdatedAt":     today,
            "calculationVersion":      CALC_VERSION,
        })
        np_cnt += 1

    # --- Validation ---
    print("\n--- バリデーション ---", flush=True)
    errors = validate(rows, strict=args.strict)
    if errors:
        for e in errors:
            print(f"  ❌ {e}", file=sys.stderr)
        print(f"\nバリデーションエラー {len(errors)} 件。出力を中止します。", file=sys.stderr)
        sys.exit(1)
    print(f"  ✅ {len(rows)} 件 全バリデーション通過", flush=True)

    expected = len(pref_muni_codes)
    actual   = len(rows)
    if actual != expected:
        print(f"  [warn] 出力件数 {actual} ≠ municipalities.json 件数 {expected}",
              flush=True)

    # --- 統計 ---
    scored  = [r for r in rows if r["stormSurgeDataStatus"] == "scored"]
    no_data = [r for r in rows if r["stormSurgeDataStatus"] == "no-storm-surge-data"]
    cands   = [r["stormSurgeRiskCandidate"] for r in rows
               if r["stormSurgeRiskCandidate"] is not None]
    ratios  = [r["stormSurgeAreaRatio"] for r in scored if r["stormSurgeAreaRatio"] is not None]
    depths  = [r["stormSurgeMaxDepthM"] for r in scored if r["stormSurgeMaxDepthM"] is not None]

    print(f"\n=== storm-surge-v1 PoC 統計 (pref={pref}) ===")
    print(f"  自治体数（N03計算） : {int_stats['scored'] + int_stats['no-storm-surge-data']}")
    print(f"  自治体数（全出力）  : {len(rows)}")
    print(f"  scored              : {len(scored)}")
    print(f"  no-storm-surge-data : {len(no_data)}")
    print(f"  not-processed       : {np_cnt}")
    print(f"  invalidGeometryCount : {int_stats['invalidGeometryCount']}")

    if cands:
        print(f"  stormSurgeRiskCandidate: min={min(cands)} / max={max(cands)}"
              f" / mean={sum(cands)/len(cands):.1f}")
    if ratios:
        print(f"  stormSurgeAreaRatio    : min={min(ratios):.6f} / max={max(ratios):.6f}"
              f" / mean={sum(ratios)/len(ratios):.6f}")
    if depths:
        print(f"  stormSurgeMaxDepthM    : min={min(depths):.1f}m / max={max(depths):.1f}m")

    top5_risky = sorted(scored, key=lambda r: r["stormSurgeRiskCandidate"])[:5]
    if top5_risky:
        print(f"\n  最危険上位5自治体（stormSurgeRiskCandidate 昇順）:")
        for r in top5_risky:
            print(f"    [{r['jisCode']}] {r['municipalityName']}"
                  f" | candidate={r['stormSurgeRiskCandidate']}"
                  f" | areaRatio={r['stormSurgeAreaRatio']:.4f}"
                  f" | maxDepthM={r['stormSurgeMaxDepthM']}m")

    top5_safe = sorted(
        [r for r in scored if r["stormSurgeRiskCandidate"] < 100],
        key=lambda r: r["stormSurgeRiskCandidate"],
        reverse=True,
    )[:5]
    if top5_safe:
        print(f"\n  scored 上位5自治体（stormSurgeRiskCandidate 降順）:")
        for r in top5_safe:
            print(f"    [{r['jisCode']}] {r['municipalityName']}"
                  f" | candidate={r['stormSurgeRiskCandidate']}"
                  f" | areaRatio={r['stormSurgeAreaRatio']:.4f}"
                  f" | maxDepthM={r['stormSurgeMaxDepthM']}m")

    # --- 出力（ラップ形式）---
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    output = {
        "generatedAt":        today,
        "version":            CALC_VERSION,
        "source":             source_str,
        "prefectureCode":     pref,
        "totalMunicipalities": len(rows),
        "stats": {
            "scored":                int_stats["scored"],
            "no-storm-surge-data":   int_stats["no-storm-surge-data"],
            "not-processed":         np_cnt,
            "not-found":             0,
            "invalidGeometryCount":  int_stats["invalidGeometryCount"],
            "unknownDepthCodeCount": 0,
        },
        "depthRiskTable": {
            "< 0.3m (0.3m未満)":    15,
            "< 0.5m (0.3-0.5m)":   30,
            "< 1.0m (0.5-1m)":      40,
            "< 3.0m (1-3m)":        55,
            "< 5.0m (3-5m)":        70,
            "< 10.0m (5-10m)":      85,
            "< 20.0m (10-20m)":     95,
            ">= 20.0m":            100,
        },
        "entries": rows,
    }

    out_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {out_path} ({len(rows)} 件, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
