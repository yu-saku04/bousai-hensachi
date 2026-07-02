"""
score-landslide-v1-all.py — 全国47都道府県 landslide-v1 スコア算出（再開可能版）

処理フロー:
  1. 都道府県ごとに A33×N03 を空間結合してスコア算出
  2. 結果を data/processed/landslide/by-pref/landslide-{pref}.json に即時保存
  3. 全県完了後（または --merge-only 時）に by-pref/ を結合して landslide-scores.json を生成
  4. 最終 JSON で municipalities.json 1918 件と突合し、未処理は "not-processed" で補完

特殊ケース:
  - pref=23 (愛知): A33 全バージョンが 404 → "not-found" で補完
  - A33 取得失敗の都道府県: "not-found" で補完

A33 列仕様:
  A33_001: 災害種別  1=土石流 / 2=急傾斜地 / 3=地すべり
  A33_002: 区域種別  1=土砂災害警戒区域（黄） / 2=土砂災害特別警戒区域（赤）

スコア仕様（実効比率 = landslideAreaRatio + landslideSpecialAreaRatio）:
  effective >= 0.20 → 20
  effective >= 0.10 → 35
  effective >= 0.05 → 50
  effective >  0   → 65
  effective == 0   → 90  (no-landslide-data)

使い方（分割実行例）:
  # 茨城単体テスト（A33 あり）
  .venv-flood/bin/python scripts/scoring/score-landslide-v1-all.py --pref-list 08

  # 全国
  .venv-flood/bin/python scripts/scoring/score-landslide-v1-all.py

  # skip-existing で再開
  .venv-flood/bin/python scripts/scoring/score-landslide-v1-all.py --skip-existing

  # by-pref/ を結合して最終 JSON を生成（処理なし）
  .venv-flood/bin/python scripts/scoring/score-landslide-v1-all.py --merge-only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_PREFS        = [f"{i:02d}" for i in range(1, 48)]
METRIC_CRS       = "EPSG:6690"   # JGD2011 / UTM zone 54N（全国一貫 metric CRS）
LANDSLIDE_SOURCE = "国土交通省 国土数値情報 土砂災害警戒区域等"
CALC_VERSION     = "landslide-v1"

A33_DEFAULT  = "A33-15"
A33_FALLBACK = {"40": "A33-13"}       # 福岡: A33-15 が存在しないため A33-13 を使用
KNOWN_MISSING = frozenset(["23"])     # 愛知: A33 全バージョンが 404（既知欠損）

N03_DATE = "20240101"
N03_YEAR = "N03-2024"
BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data"

VALID_STATUSES = frozenset(["scored", "no-landslide-data", "not-found", "not-processed"])
JIS_DIGITS     = frozenset("0123456789")

RAW_A33   = Path("data/raw/landslide/A33")
RAW_N03   = Path("data/raw/flood/N03")
BY_PREF   = Path("data/processed/landslide/by-pref")
MUNI_JSON = Path("src/data/municipalities.json")

# ---------------------------------------------------------------------------
# A33 version helpers
# ---------------------------------------------------------------------------

def a33_ver(pref: str) -> str:
    return A33_FALLBACK.get(pref, A33_DEFAULT)

# ---------------------------------------------------------------------------
# Pref selection helpers
# ---------------------------------------------------------------------------

def resolve_prefs(
    pref_list: list[str] | None,
    pref_start: str | None,
    pref_end: str | None,
) -> list[str]:
    if pref_list:
        return [p.zfill(2) for p in pref_list]
    start = int(pref_start) if pref_start else 1
    end   = int(pref_end)   if pref_end   else 47
    return [f"{i:02d}" for i in range(start, end + 1)]

# ---------------------------------------------------------------------------
# URL / path helpers
# ---------------------------------------------------------------------------

def a33_url(pref: str) -> str:
    ver = a33_ver(pref)
    return f"{BASE_URL}/A33/{ver}/{ver}_{pref}_GML.zip"

def n03_url(pref: str) -> str:
    return f"{BASE_URL}/N03/{N03_YEAR}/N03-{N03_DATE}_{pref}_GML.zip"

def a33_zip(pref: str) -> Path:
    return RAW_A33 / f"{a33_ver(pref)}_{pref}_GML.zip"

def n03_zip(pref: str) -> Path:
    return RAW_N03 / f"N03-{N03_DATE}_{pref}_GML.zip"

def pref_json(pref: str) -> Path:
    return BY_PREF / f"landslide-{pref}.json"

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_zip(url: str, dest: Path) -> str:
    """Returns 'ok' | 'skip' | 'not-found' | 'error-{code}'.

    一時ファイル (.tmp) にダウンロードし、成功後に dest へリネームする。
    """
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

# ---------------------------------------------------------------------------
# GML loading
# ---------------------------------------------------------------------------

def load_gml(zip_path: Path):
    """ZIP 内の shapefile / GML を読み込む。SHP 優先 → XML/GML フォールバック。"""
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
        for candidate in candidates:
            try:
                gdf = gpd.read_file(f"zip://{zip_path.resolve()}!{candidate}")
                if len(gdf) > 0:
                    return gdf
                print(f"  [warn] fallback {candidate} が空", flush=True)
            except Exception as _e2:
                print(f"  [warn] fallback {candidate} 失敗: {_e2}", flush=True)

    raise RuntimeError(f"有効なフィーチャが見つかりません: {zip_path}")

def find_jis_col(gdf) -> str:
    for c in ("N03_007", "N03_007_", "jiscode"):
        if c in gdf.columns:
            return c
    raise RuntimeError(f"JISコード列が見つかりません。列: {list(gdf.columns)}")

# ---------------------------------------------------------------------------
# Score formula
# ---------------------------------------------------------------------------

def score_from_effective(effective: float) -> int:
    """実効危険度比率（area_ratio + special_ratio）からスコアを返す。"""
    if effective >= 0.20:
        return 20
    if effective >= 0.10:
        return 35
    if effective >= 0.05:
        return 50
    if effective > 0:
        return 65
    return 90

# ---------------------------------------------------------------------------
# Row builder
# ---------------------------------------------------------------------------

def _make_row(
    jisCode: str,
    prefecture: str,
    municipality: str,
    score: int | None,
    status: str,
    area_ratio: float | None,
    special_ratio: float | None,
    today: str,
) -> dict:
    source = LANDSLIDE_SOURCE if status in ("scored", "no-landslide-data") else None
    return {
        "jisCode":                   jisCode,
        "prefecture":                prefecture,
        "municipality":              municipality,
        "landslideRiskCandidate":    score,
        "landslideDataStatus":       status,
        "landslideAreaRatio":        area_ratio,
        "landslideSpecialAreaRatio": special_ratio,
        "landslideSource":           source,
        "landslideUpdatedAt":        today,
        "calculationVersion":        CALC_VERSION,
    }

# ---------------------------------------------------------------------------
# N03 municipality list helper
# ---------------------------------------------------------------------------

def _load_n03_name_df(n03_path: Path):
    """N03 から自治体コード・名称 DataFrame を返す。"""
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
# Per-prefecture computation
# ---------------------------------------------------------------------------

def compute_pref_not_found(pref: str, n03_path: Path) -> list[dict]:
    """A33 データなし → 全自治体を "not-found" で返す。"""
    print(f"  [not-found] N03 から自治体リストを取得中: {n03_path.name}", flush=True)
    name_df, jis_col = _load_n03_name_df(n03_path)
    today = date.today().isoformat()
    rows = [
        _make_row(
            jisCode      = str(r[jis_col]),
            prefecture   = str(r.get("prefecture") or ""),
            municipality = str(r.get("name") or ""),
            score        = None,
            status       = "not-found",
            area_ratio   = None,
            special_ratio= None,
            today        = today,
        )
        for _, r in name_df.iterrows()
    ]
    print(f"  [not-found] {len(rows)} 件", flush=True)
    return rows


def compute_pref(pref: str) -> list[dict]:
    """A33×N03 空間結合 → landslide-v1 スコア算出。"""
    import geopandas as gpd
    import pandas as pd

    a33 = load_gml(a33_zip(pref))
    n03 = load_gml(n03_zip(pref))

    jis_col = find_jis_col(n03)

    # A33_002 を数値化（shapefile では文字列になる場合がある）
    if "A33_002" in a33.columns:
        a33 = a33.copy()
        a33["A33_002"] = pd.to_numeric(a33["A33_002"], errors="coerce")

    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    # A33 が空なら全自治体 no-landslide-data
    if len(a33) == 0:
        print(f"  [warn] A33 フィーチャなし → 全自治体 no-landslide-data", flush=True)
        today = date.today().isoformat()
        return [
            _make_row(str(r[jis_col]), str(r.get("prefecture") or ""),
                      str(r.get("name") or ""), 90, "no-landslide-data", 0.0, 0.0, today)
            for _, r in name_df.iterrows()
        ]

    a33_m    = a33.to_crs(METRIC_CRS)
    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area

    print(f"  A33: {len(a33_m)} ポリゴン | N03 自治体数: {len(n03_muni)}", flush=True)

    # 警戒区域列のうち geometry + 必要列のみを overlay に渡す
    a33_cols = ["geometry"]
    if "A33_002" in a33_m.columns:
        a33_cols = ["A33_002", "geometry"]

    print("  空間結合（A33 ∩ N03）実行中…", flush=True)
    joined = gpd.overlay(
        a33_m[a33_cols],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area
    print(f"  overlay 結果: {len(joined)} 行", flush=True)

    # 全警戒区域集計
    agg_all = joined.groupby(jis_col).agg(
        zone_area_m2=("clip_area_m2", "sum"),
    ).reset_index()

    # 特別警戒区域（赤: A33_002 == 2）集計
    agg_special = pd.DataFrame(columns=[jis_col, "special_zone_area_m2"])
    if "A33_002" in joined.columns:
        joined_special = joined[joined["A33_002"] == 2]
        if len(joined_special) > 0:
            agg_special = joined_special.groupby(jis_col).agg(
                special_zone_area_m2=("clip_area_m2", "sum"),
            ).reset_index()

    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg_all,     on=jis_col, how="left")
    result = result.merge(agg_special, on=jis_col, how="left")
    result = result.merge(name_df,     on=jis_col, how="left")

    result["zone_area_m2"]         = result["zone_area_m2"].fillna(0.0)
    result["special_zone_area_m2"] = result["special_zone_area_m2"].fillna(0.0)

    # 複数ポリゴン重複で sum > muni_area_m2 になりうる → clamp
    result["landslide_area_ratio"]   = (
        result["zone_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)
    result["landslide_special_ratio"] = (
        result["special_zone_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

    # 実効危険度比率: area_ratio + special_ratio（特別警戒区域を二重計上）
    result["effective_ratio"] = (
        result["landslide_area_ratio"] + result["landslide_special_ratio"]
    ).clip(upper=1.0)

    today = date.today().isoformat()
    rows: list[dict] = []
    for _, r in result.iterrows():
        area_ratio    = float(r["landslide_area_ratio"])
        special_ratio = float(r["landslide_special_ratio"])
        effective     = float(r["effective_ratio"])
        score         = score_from_effective(effective)
        status        = "scored" if area_ratio > 0 else "no-landslide-data"
        rows.append(_make_row(
            jisCode      = str(r[jis_col]),
            prefecture   = str(r.get("prefecture") or ""),
            municipality = str(r.get("name") or ""),
            score        = score,
            status       = status,
            area_ratio   = round(area_ratio, 6),
            special_ratio= round(special_ratio, 6),
            today        = today,
        ))

    return rows

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _check_row(r: dict, i: int, seen: dict[str, int], errors: list[str]) -> None:
    tag = f"[行{i+1}][{r.get('jisCode', '?')}]"
    jis = str(r.get("jisCode", ""))

    if len(jis) != 5 or not all(c in JIS_DIGITS for c in jis):
        errors.append(f"{tag} jisCode 5桁数字必須: {jis!r}")
    elif jis in seen:
        errors.append(f"{tag} jisCode 重複: 初出行{seen[jis]+1}")
    else:
        seen[jis] = i

    status = r.get("landslideDataStatus", "")
    if status not in VALID_STATUSES:
        errors.append(f"{tag} landslideDataStatus 不正: {status!r}")

    score = r.get("landslideRiskCandidate")
    if status in ("scored", "no-landslide-data"):
        if not (isinstance(score, int) and 10 <= score <= 90):
            errors.append(f"{tag} landslideRiskCandidate: 10〜90整数必須: {score!r}")
        if status == "no-landslide-data" and score != 90:
            errors.append(f"{tag} no-landslide-data の候補値は 90 必須: {score!r}")
    elif status in ("not-found", "not-processed"):
        if score is not None:
            errors.append(f"{tag} {status} の landslideRiskCandidate は null 必須: {score!r}")

    ratio = r.get("landslideAreaRatio")
    if ratio is not None and not (0.0 <= ratio <= 1.0):
        errors.append(f"{tag} landslideAreaRatio: 0〜1必須: {ratio!r}")

    if r.get("calculationVersion") != CALC_VERSION:
        errors.append(f"{tag} calculationVersion: {CALC_VERSION!r} 必須")


def validate_pref(pref: str, rows: list[dict]) -> list[str]:
    errors: list[str] = []
    seen: dict[str, int] = {}
    for i, r in enumerate(rows):
        _check_row(r, i, seen, errors)
    if errors:
        errors = [f"[pref={pref}] {e}" for e in errors]
    return errors


def validate_final(rows: list[dict], muni_jis: set[str]) -> list[str]:
    errors: list[str] = []
    seen: dict[str, int] = {}
    for i, r in enumerate(rows):
        _check_row(r, i, seen, errors)

    missing = muni_jis - set(seen.keys())
    if missing:
        errors.append(
            f"municipalities.json にあるが出力に含まれない JIS コード {len(missing)} 件: "
            f"{sorted(missing)[:10]}{'…' if len(missing) > 10 else ''}"
        )
    return errors

# ---------------------------------------------------------------------------
# by-pref I/O
# ---------------------------------------------------------------------------

def save_pref_json(pref: str, rows: list[dict]) -> None:
    dest = pref_json(pref)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

def load_pref_json(pref: str) -> list[dict] | None:
    p = pref_json(pref)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))

# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def do_merge(out_path: Path, muni_data: list[dict]) -> None:
    muni_jis  = {m["jisCode"] for m in muni_data if m.get("jisCode")}
    muni_info = {m["jisCode"]: m for m in muni_data if m.get("jisCode")}

    all_rows: list[dict] = []
    loaded_prefs: list[str] = []

    for pref in ALL_PREFS:
        rows = load_pref_json(pref)
        if rows is not None:
            all_rows.extend(rows)
            loaded_prefs.append(pref)

    if not all_rows:
        print("ERROR: by-pref/ に JSON が1件もありません。先に処理を実行してください。",
              file=sys.stderr)
        sys.exit(1)

    print(f"  マージ対象: {loaded_prefs}")
    print(f"  マージ前総件数: {len(all_rows)}")

    # not-processed 補完（municipalities.json にあるが overlay に含まれなかったコード）
    # → 政令市の市全体コード（N03 には区コードのみ存在するため）
    today = date.today().isoformat()
    processed_jis = {r["jisCode"] for r in all_rows}
    for jis in sorted(muni_jis - processed_jis):
        m = muni_info[jis]
        all_rows.append({
            "jisCode":                   jis,
            "prefecture":                m.get("prefecture", ""),
            "municipality":              m.get("municipality", ""),
            "landslideRiskCandidate":    None,
            "landslideDataStatus":       "not-processed",
            "landslideAreaRatio":        None,
            "landslideSpecialAreaRatio": None,
            "landslideSource":           None,
            "landslideUpdatedAt":        today,
            "calculationVersion":        CALC_VERSION,
        })

    all_rows.sort(key=lambda r: r["jisCode"])

    # 最終バリデーション
    print("\n--- 最終バリデーション ---")
    errors = validate_final(all_rows, muni_jis)
    if errors:
        for e in errors[:20]:
            print(f"  ❌ {e}", file=sys.stderr)
        if len(errors) > 20:
            print(f"  ... 他 {len(errors)-20} 件", file=sys.stderr)
        print(f"\nバリデーションエラー {len(errors)} 件。出力を中止します。", file=sys.stderr)
        sys.exit(1)
    print(f"  ✅ {len(all_rows)} 件 全バリデーション通過")

    # 統計
    scored_rows    = [r for r in all_rows if r["landslideDataStatus"] == "scored"]
    no_land_rows   = [r for r in all_rows if r["landslideDataStatus"] == "no-landslide-data"]
    not_found_rows = [r for r in all_rows if r["landslideDataStatus"] == "not-found"]
    not_proc_rows  = [r for r in all_rows if r["landslideDataStatus"] == "not-processed"]
    candidates     = [r["landslideRiskCandidate"] for r in scored_rows + no_land_rows]
    ratios         = [r["landslideAreaRatio"] for r in scored_rows]

    print(f"\n=== landslide-v1 マージ統計 ===")
    print(f"  総出力件数         : {len(all_rows)}")
    print(f"  scored             : {len(scored_rows)}")
    print(f"  no-landslide-data  : {len(no_land_rows)}")
    print(f"  not-found          : {len(not_found_rows)}")
    print(f"  not-processed      : {len(not_proc_rows)}")
    print(f"  マージ済み都道府県 : {len(loaded_prefs)}/{len(ALL_PREFS)}")
    if candidates:
        print(f"\n  landslideRiskCandidate: min={min(candidates)} / max={max(candidates)} "
              f"/ mean={sum(candidates)/len(candidates):.1f}")
    if ratios:
        print(f"  landslideAreaRatio    : min={min(ratios):.4f} / max={max(ratios):.4f} "
              f"/ mean={sum(ratios)/len(ratios):.4f}")

    if scored_rows:
        print(f"\n  最危険 上位10（landslideRiskCandidate 昇順）:")
        for r in sorted(scored_rows, key=lambda x: x["landslideRiskCandidate"])[:10]:
            print(f"    [{r['jisCode']}] {r['prefecture']} {r['municipality']}"
                  f" | score={r['landslideRiskCandidate']}"
                  f" | area={r['landslideAreaRatio']:.3f}")

        print(f"\n  最安全 上位10（scored のみ, 降順）:")
        for r in sorted(scored_rows, key=lambda x: x["landslideRiskCandidate"], reverse=True)[:10]:
            print(f"    [{r['jisCode']}] {r['prefecture']} {r['municipality']}"
                  f" | score={r['landslideRiskCandidate']}"
                  f" | area={r['landslideAreaRatio']:.3f}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(all_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {out_path} ({len(all_rows)} 件, {size_kb:.0f} KB)")
    print("   municipalities.json は変更されていません。")

# ---------------------------------------------------------------------------
# Processing loop
# ---------------------------------------------------------------------------

def do_process(prefs: list[str], args: argparse.Namespace, muni_data: list[dict]) -> None:
    do_dl         = not args.no_download
    skip_existing = args.skip_existing

    pref_results: list[tuple[str, str, int]] = []  # (pref, status, count)

    for pref in prefs:
        # skip-existing チェック
        if skip_existing and pref_json(pref).exists():
            existing = load_pref_json(pref)
            n = len(existing) if existing else 0
            print(f"[{pref}] skip (既存 {pref_json(pref).name}, {n}件)")
            pref_results.append((pref, "skipped", n))
            continue

        t0 = time.time()

        # KNOWN_MISSING（A33 全バージョンが 404）
        if pref in KNOWN_MISSING:
            print(f"\n[{pref}] KNOWN_MISSING (A33 全バージョン 404) → not-found", flush=True)
            if not n03_zip(pref).exists():
                if do_dl:
                    res = download_zip(n03_url(pref), n03_zip(pref))
                    if res not in ("ok", "skip"):
                        print(f"  [N03] DL失敗 ({res}) → skip", flush=True)
                        pref_results.append((pref, "dl-failed", 0))
                        continue
                else:
                    print(f"  [N03] 未取得 (--no-download): {n03_zip(pref).name}", flush=True)
                    pref_results.append((pref, "dl-failed", 0))
                    continue
            try:
                rows = compute_pref_not_found(pref, n03_zip(pref))
                v_errors = validate_pref(pref, rows)
                if v_errors:
                    for e in v_errors[:5]:
                        print(f"    ❌ {e}", file=sys.stderr)
                    pref_results.append((pref, "validate-failed", 0))
                    continue
                save_pref_json(pref, rows)
                elapsed = time.time() - t0
                print(f"  [{pref}] ✅ {len(rows)}自治体 (not-found) {elapsed:.0f}s → {pref_json(pref)}")
                pref_results.append((pref, "not-found", len(rows)))
            except Exception as e:
                print(f"  [{pref}] ❌ エラー: {e}", file=sys.stderr)
                pref_results.append((pref, "error", 0))
            continue

        print(f"\n[{pref}] 処理開始…", flush=True)

        # N03 ダウンロード
        n03_ok = True
        if do_dl:
            res = download_zip(n03_url(pref), n03_zip(pref))
            if res == "ok":
                print(f"  [N03] DL完了: {n03_zip(pref).name}", flush=True)
            elif res == "skip":
                print(f"  [N03] skip (既存): {n03_zip(pref).name}", flush=True)
            else:
                print(f"  [N03] {res}: {n03_url(pref)}", flush=True)
                n03_ok = False
        else:
            if not n03_zip(pref).exists():
                print(f"  [N03] 未取得 (--no-download): {n03_zip(pref).name}", flush=True)
                n03_ok = False

        if not n03_ok:
            print(f"  [{pref}] N03 不足 → skip")
            pref_results.append((pref, "dl-failed", 0))
            continue

        # A33 ダウンロード
        a33_ok = True
        if do_dl:
            res = download_zip(a33_url(pref), a33_zip(pref))
            if res == "ok":
                print(f"  [A33] DL完了: {a33_zip(pref).name}", flush=True)
            elif res == "skip":
                print(f"  [A33] skip (既存): {a33_zip(pref).name}", flush=True)
            elif res == "not-found":
                print(f"  [A33] not-found: {a33_url(pref)}", flush=True)
                a33_ok = False
            else:
                print(f"  [A33] {res}: {a33_url(pref)}", flush=True)
                a33_ok = False
        else:
            if not a33_zip(pref).exists():
                print(f"  [A33] 未取得 (--no-download): {a33_zip(pref).name}", flush=True)
                a33_ok = False

        # 空間結合・スコア計算
        try:
            if not a33_ok:
                print(f"  [{pref}] A33 なし → not-found", flush=True)
                rows = compute_pref_not_found(pref, n03_zip(pref))
                status_label = "not-found"
            else:
                rows = compute_pref(pref)
                status_label = "processed"

            v_errors = validate_pref(pref, rows)
            if v_errors:
                print(f"  [{pref}] バリデーションエラー {len(v_errors)} 件:", file=sys.stderr)
                for e in v_errors[:5]:
                    print(f"    ❌ {e}", file=sys.stderr)
                pref_results.append((pref, "validate-failed", 0))
                continue

            save_pref_json(pref, rows)
            elapsed    = time.time() - t0
            scored_n   = sum(1 for r in rows if r["landslideDataStatus"] == "scored")
            no_land_n  = sum(1 for r in rows if r["landslideDataStatus"] == "no-landslide-data")
            not_fnd_n  = sum(1 for r in rows if r["landslideDataStatus"] == "not-found")
            print(f"  [{pref}] ✅ {len(rows)}自治体 "
                  f"(scored={scored_n}, no-land={no_land_n}, not-found={not_fnd_n}) "
                  f"{elapsed:.0f}s → {pref_json(pref)}")
            pref_results.append((pref, status_label, len(rows)))

        except Exception as e:
            print(f"  [{pref}] ❌ エラー: {e}", file=sys.stderr)
            pref_results.append((pref, "error", 0))

    # ループ後サマリー
    print(f"\n--- 処理サマリー ---")
    for pref, status, cnt in pref_results:
        if status in ("processed", "skipped", "not-found"):
            mark = "✅"
        elif status == "dl-failed":
            mark = "⚠️ "
        else:
            mark = "❌"
        print(f"  {mark} {pref}: {status:<16} {cnt:>4}自治体")

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="landslide-v1 全国スコア算出")
    p.add_argument("--pref-start", metavar="CODE",
                   help="処理開始都道府県コード（例: 05）")
    p.add_argument("--pref-end",   metavar="CODE",
                   help="処理終了都道府県コード（例: 10）")
    p.add_argument("--pref-list",  nargs="+", metavar="CODE",
                   help="処理対象都道府県コードをスペース区切りで指定")
    p.add_argument("--skip-existing", action="store_true",
                   help="by-pref/ に既存 JSON がある県をスキップ")
    p.add_argument("--no-download", action="store_true",
                   help="自動 DL 無効（既存 ZIP のみ処理）")
    p.add_argument("--merge-only",  action="store_true",
                   help="DL・計算なし。by-pref/ を結合して landslide-scores.json を生成")
    p.add_argument("--output", default="data/processed/landslide-scores.json",
                   help="最終 JSON 出力先")
    return p.parse_args()

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args     = parse_args()
    out_path = Path(args.output)

    if not MUNI_JSON.exists():
        print(f"ERROR: {MUNI_JSON} が見つかりません", file=sys.stderr)
        sys.exit(1)
    muni_data = json.loads(MUNI_JSON.read_text(encoding="utf-8"))
    print(f"municipalities.json: {len(muni_data)} 件\n")

    if args.merge_only:
        print("=== merge-only モード ===")
        do_merge(out_path, muni_data)
        return

    prefs = resolve_prefs(args.pref_list, args.pref_start, args.pref_end)
    print(f"処理対象: {prefs}")
    print(f"skip-existing: {args.skip_existing}")
    print(f"no-download  : {args.no_download}\n")

    do_process(prefs, args, muni_data)

    print(f"\n=== 処理完了 → マージ開始 ===")
    do_merge(out_path, muni_data)


if __name__ == "__main__":
    main()
