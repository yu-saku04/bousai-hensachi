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
  それ以外の沿岸県 (24県): not-found

スコア仕様（0〜100, 高いほど安全）:
  area_risk  = clamp(area_ratio*100, 0, 100)
  depth_risk = depth_risk_storm_surge(max_depth_lower_m)
  combined   = 0.6 * area_risk + 0.4 * depth_risk
  score      = clamp(round(100 - combined), 0, 100)
  no-storm-surge-data → 100, no-storm-surge-risk → 100

使い方:
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --skip-existing
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --merge-only
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --pref-list 14 27 40
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --no-download
  .venv-flood/bin/python scripts/scoring/score-storm-surge-v1-all.py --strict
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_PREFS     = [f"{i:02d}" for i in range(1, 48)]
METRIC_CRS    = "EPSG:6690"   # JGD2011 / UTM zone 54N
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

# 修復率警告閾値
REPAIR_RATE_WARN  = 0.05   # 5%
REPAIR_RATE_ERROR = 0.10   # 10%（--strict 時にエラー）


# ---------------------------------------------------------------------------
# Depth parsing (A49_003 は自由テキスト形式、A40_003 と同一フォーマット)
# ---------------------------------------------------------------------------

_DEPTH_LOWER_RE = re.compile(r"(?P<lower>\d+(?:\.\d+)?)\s*(?:m|メートル)?\s*以上")
_DEPTH_EXACT_RE = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s*(?:m|メートル)?")

# 既知の「ゼロ下限」パターン（0.3m未満 など）
_NULL_LIKE = {"", "nan", "none", "null", "-", "－", "—"}


def parse_storm_surge_depth(raw: str | None) -> tuple[float, bool]:
    """
    A49_003 テキストから (浸水深下限値 m, is_known) を返す。
    is_known=False: 入力が null でないのにパターン未一致（未知値）。
    未知値を 0.0 扱いしない。呼び出し元で警告/エラー処理すること。
    """
    if raw is None:
        return 0.0, True  # null は既知（浸水深情報なし）
    normalized = unicodedata.normalize("NFKC", str(raw)).strip()
    normalized = re.sub(r"\s+", "", normalized)
    if normalized.lower() in _NULL_LIKE or normalized in {"-", "－", "—"}:
        return 0.0, True

    m = _DEPTH_LOWER_RE.search(normalized)
    if m:
        return float(m.group("lower")), True

    # '0.3m未満' のような上限のみ → 下限 0.0m（既知）
    if "未満" in normalized or "以下" in normalized:
        return 0.0, True

    m = _DEPTH_EXACT_RE.fullmatch(normalized)
    if m:
        return float(m.group("value")), True

    return 0.0, False  # 未知パターン


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


def _valid_jis(code: str) -> bool:
    """5桁数字かつ所属未定地（末尾3桁が000）を除外。"""
    return (
        len(code) == 5
        and all(c in JIS_DIGITS for c in code)
        and code[2:] != "000"
    )


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
    print(f"  pref={pref}: 内陸県 → no-storm-surge-risk (score=100)", flush=True)
    try:
        n03 = load_gml(n03_path)
    except Exception as e:
        print(f"  [warn] N03 読み込み失敗: {e} — pref={pref} をスキップ", flush=True)
        return []

    jis_col = find_jis_col(n03)
    n03_clean = n03[
        n03[jis_col].notna()
        & n03[jis_col].apply(lambda c: _valid_jis(str(c)))
    ].copy()
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
    print(f"  pref={pref}: NLFTP 未収録 → not-found", flush=True)
    try:
        n03 = load_gml(n03_path)
    except Exception as e:
        print(f"  [warn] N03 読み込み失敗: {e} — pref={pref} をスキップ", flush=True)
        return []

    jis_col = find_jis_col(n03)
    n03_clean = n03[
        n03[jis_col].notna()
        & n03[jis_col].apply(lambda c: _valid_jis(str(c)))
    ].copy()
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


def compute_pref(
    pref: str,
    today: str,
    n03_path: Path,
    a49_path: Path,
    strict: bool = False,
) -> list[dict]:
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
    total_poly = len(a49)
    print(f"    A49: {total_poly} ポリゴン, CRS={a49.crs}", flush=True)

    # --- A49_003 → 浸水深下限値・未知パターン集計 ---
    unknown_depth_patterns: Counter = Counter()
    if "A49_003" in a49.columns:
        a49 = a49.copy()
        depth_lower_list = []
        for v in a49["A49_003"]:
            lower_m, is_known = parse_storm_surge_depth(str(v) if v is not None else None)
            if not is_known:
                unknown_depth_patterns[str(v)] += 1
                depth_lower_list.append(0.0)
            else:
                depth_lower_list.append(lower_m)
        a49["depth_lower_m"] = depth_lower_list

        if unknown_depth_patterns:
            print(f"    [warn] A49_003 未知パターン {sum(unknown_depth_patterns.values())} 件:",
                  flush=True)
            for pat, cnt in unknown_depth_patterns.most_common():
                print(f"      {pat!r}: {cnt}件", flush=True)
            if strict:
                print(f"    [strict] 未知深度パターンが存在するため終了します。",
                      file=sys.stderr)
                sys.exit(1)
    else:
        print(f"    [warn] A49_003 列なし — depth_lower_m=0.0 で処理", flush=True)
        a49 = a49.copy()
        a49["depth_lower_m"] = 0.0

    # --- A49 ジオメトリ品質チェック ---
    null_cnt  = int(a49.geometry.isna().sum())
    empty_cnt = int((~a49.geometry.isna() & a49.geometry.is_empty).sum())
    if null_cnt or empty_cnt:
        print(f"    [warn] null geometry: {null_cnt}件 / empty: {empty_cnt}件 → 除外",
              flush=True)
        a49 = a49[~a49.geometry.isna() & ~a49.geometry.is_empty].copy()

    inv_mask = ~a49.geometry.is_valid
    inv_cnt  = int(inv_mask.sum())
    repaired = 0
    if inv_cnt > 0:
        print(f"    [info] invalid geometry: {inv_cnt}件 → 修復中", flush=True)
        a49 = a49.copy()
        if HAS_MAKE_VALID:
            a49.loc[inv_mask, "geometry"] = (
                a49.loc[inv_mask, "geometry"].apply(make_valid)
            )
        still_inv = ~a49.geometry.is_valid
        a49.loc[still_inv, "geometry"] = (
            a49.loc[still_inv, "geometry"].buffer(0)
        )
        repaired = inv_cnt - int((~a49.geometry.is_valid).sum())
        print(f"    [info] 修復完了: {repaired}件 / 失敗残: {inv_cnt - repaired}件",
              flush=True)

    repair_rate = inv_cnt / total_poly if total_poly > 0 else 0.0
    if repair_rate > REPAIR_RATE_ERROR:
        msg = (f"    [warn] pref={pref}: 修復率 {repair_rate:.1%} が 10% 超"
               f" ({inv_cnt}/{total_poly})")
        print(msg, flush=True)
        if strict:
            print(f"    [strict] 修復率超過のため終了します。", file=sys.stderr)
            sys.exit(1)
    elif repair_rate > REPAIR_RATE_WARN:
        print(f"    [warn] pref={pref}: 修復率 {repair_rate:.1%} が 5% 超"
              f" ({inv_cnt}/{total_poly})", flush=True)

    if a49.crs is None:
        print("    [warn] A49 CRS 不明 → JGD2011 (EPSG:6668) 仮定", flush=True)
        a49 = a49.set_crs("EPSG:6668")

    # null/empty 除外（修復後）
    a49 = a49[~a49.geometry.isna() & ~a49.geometry.is_empty].copy()

    # --- N03 ---
    n03 = load_gml(n03_path)
    jis_col = find_jis_col(n03)
    n03_clean = n03[
        n03[jis_col].notna()
        & n03[jis_col].apply(lambda c: _valid_jis(str(c)))
    ].copy()

    n03_inv = int((~n03_clean.geometry.is_valid).sum())
    if n03_inv > 0:
        print(f"    [info] N03 invalid geometry: {n03_inv}件 → 修復中", flush=True)
        n03_clean = n03_clean.copy()
        if HAS_MAKE_VALID:
            n03_clean.loc[~n03_clean.geometry.is_valid, "geometry"] = (
                n03_clean.loc[~n03_clean.geometry.is_valid, "geometry"].apply(make_valid)
            )
        n03_clean.loc[~n03_clean.geometry.is_valid, "geometry"] = (
            n03_clean.loc[~n03_clean.geometry.is_valid, "geometry"].buffer(0)
        )

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

    # --- 空間 overlay ---
    joined = gpd.overlay(
        a49_m[["depth_lower_m", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area
    print(f"    overlay 結果: {len(joined)} 行", flush=True)

    if len(joined) == 0:
        print(f"    [warn] overlay 結果が 0 件。A49 と N03 が空間的に重複していない可能性。",
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
    # 重複ポリゴンで sum > muni_area になりうる → 1.0 でクランプ
    result["storm_surge_area_ratio"] = (
        result["storm_surge_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

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
            cand   = score_candidate(area_rat, max_depth)
            status = "scored"
            a_out  = round(area_rat, 6)
            d_out  = round(max_depth, 2)
            scored_cnt += 1
        else:
            cand   = 100
            status = "no-storm-surge-data"
            a_out  = 0.0
            d_out  = None
            no_data_cnt += 1

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

    print(f"    scored={scored_cnt} / no-data={no_data_cnt}"
          f" / unknownDepth={sum(unknown_depth_patterns.values())}"
          f" / invalidGeom={inv_cnt} (repair_rate={repair_rate:.1%})",
          flush=True)
    return rows


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_merged(
    rows: list[dict],
    muni_codes: set[str],
    strict: bool = False,
) -> list[str]:
    """全国マージ後の全件バリデーション。"""
    errors: list[str] = []
    seen: dict[str, int] = {}

    for i, r in enumerate(rows):
        tag = f"[行{i+1}][{r.get('jisCode', '?')}]"
        jis = r.get("jisCode", "")

        # JISコード形式
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
                errors.append(f"{tag} no-storm-surge-data: areaRatio=0.0 必須: {ratio!r}")
            if depth is not None:
                errors.append(f"{tag} no-storm-surge-data: maxDepthM=null 必須: {depth!r}")

        elif status == "no-storm-surge-risk":
            if cand != 100:
                errors.append(f"{tag} no-storm-surge-risk: score=100 必須: {cand!r}")

        elif status in ("not-found", "not-processed", "missing"):
            if cand is not None:
                errors.append(f"{tag} {status}: score=null 必須: {cand!r}")

        if ratio is not None and not (0.0 <= ratio <= 1.0):
            errors.append(f"{tag} stormSurgeAreaRatio: 0〜1 必須: {ratio!r}")

        if r.get("calculationVersion") != CALC_VERSION:
            errors.append(f"{tag} calculationVersion 不正: {r.get('calculationVersion')!r}")

    # municipalities.json との差分
    scored_codes = set(seen.keys())
    extra  = sorted(scored_codes - muni_codes)
    missing = sorted(muni_codes - scored_codes)
    if extra:
        errors.append(f"municipalities.json に存在しない余分コード {len(extra)} 件: {extra[:10]}")
    if missing:
        errors.append(f"municipalities.json の不足コード {len(missing)} 件: {missing[:10]}")

    return errors


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def do_merge(output_path: Path, strict: bool = False) -> None:
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
    muni_codes  = {m["jisCode"] for m in muni_list}
    muni_map    = {m["jisCode"]: m for m in muni_list}
    scored_codes = {r["jisCode"] for r in all_rows}

    not_processed_codes = muni_codes - scored_codes
    today = date.today().isoformat()
    for code in sorted(not_processed_codes):
        m = muni_map.get(code, {})
        all_rows.append(_make_row(
            jis_code       = code,
            pref_code      = code[:2],
            prefecture     = m.get("prefecture", ""),
            name           = m.get("municipality", ""),
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
    status_counts = Counter(r["stormSurgeDataStatus"] for r in all_rows)
    for st, cnt in sorted(status_counts.items()):
        print(f"    {st:<30s}: {cnt}")

    # 県別件数
    pref_counts = Counter(r["prefectureCode"] for r in all_rows)
    print(f"\n  県別件数（上位10）:")
    for pref, cnt in pref_counts.most_common(10):
        print(f"    pref={pref}: {cnt}")

    # スコア統計
    scored_rows = [r for r in all_rows if r["stormSurgeDataStatus"] == "scored"]
    cands  = [r["stormSurgeRiskCandidate"] for r in scored_rows if r["stormSurgeRiskCandidate"] is not None]
    ratios = [r["stormSurgeAreaRatio"] for r in scored_rows if r["stormSurgeAreaRatio"] is not None]
    depths = [r["stormSurgeMaxDepthM"] for r in scored_rows if r["stormSurgeMaxDepthM"] is not None]
    if cands:
        print(f"\n  stormSurgeRiskCandidate: min={min(cands)} max={max(cands)} mean={sum(cands)/len(cands):.1f}")
    if ratios:
        print(f"  stormSurgeAreaRatio    : min={min(ratios):.6f} max={max(ratios):.6f} mean={sum(ratios)/len(ratios):.6f}")
    if depths:
        # maxDepthM は下限値 (m)
        print(f"  stormSurgeMaxDepthM    : min={min(depths):.2f}m max={max(depths):.2f}m")

    # --- バリデーション ---
    print(f"\n--- バリデーション ---")
    errors = validate_merged(all_rows, muni_codes, strict=strict)
    if errors:
        for e in errors:
            print(f"  ❌ {e}", file=sys.stderr)
        print(f"\nバリデーションエラー {len(errors)} 件。", file=sys.stderr)
        if strict:
            print("--strict 指定のため出力を中止します。", file=sys.stderr)
            sys.exit(1)
        print("警告として続行します（--strict で中止）。", file=sys.stderr)
    else:
        print(f"  ✅ {len(all_rows)} 件 全バリデーション通過")

    # expected == actual 確認
    if len(all_rows) != len(muni_codes):
        print(f"  [warn] 出力件数 {len(all_rows)} ≠ municipalities.json {len(muni_codes)} 件",
              flush=True)

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

def run_pref(
    pref: str,
    skip_existing: bool,
    no_download: bool,
    strict: bool = False,
) -> list[dict]:
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
                print(f"  [warn] pref={pref}: A49 ファイルなし、--no-download のためスキップ",
                      flush=True)
                return []
            print(f"  [warn] pref={pref}: A49 ファイルなし。先に"
                  f" fetch-nlftp-storm-surge.py を実行してください。",
                  flush=True)
            rows = compute_pref_not_found(pref, today, n03_path)
        else:
            rows = compute_pref(pref, today, n03_path, a49_path, strict=strict)

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
    parser.add_argument("--strict", action="store_true",
                        help="バリデーションエラー・未知深度・高修復率でエラー終了")
    args = parser.parse_args()

    if args.merge_only:
        do_merge(args.output, strict=args.strict)
        return

    prefs = args.pref_list if args.pref_list else ALL_PREFS
    prefs = [p.zfill(2) for p in prefs]

    print(f"対象都道府県: {prefs}")
    print(f"skip-existing: {args.skip_existing}")
    print(f"no-download  : {args.no_download}")
    print(f"strict       : {args.strict}\n")

    for pref in prefs:
        print(f"\n[pref={pref}]", flush=True)
        run_pref(pref, args.skip_existing, args.no_download, strict=args.strict)

    do_merge(args.output, strict=args.strict)


if __name__ == "__main__":
    main()
