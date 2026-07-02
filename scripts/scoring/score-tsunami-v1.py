"""
score-tsunami-v1.py — A40×N03 空間結合 → tsunamiRiskCandidate 算出 (PoC / pref=08)

スコア仕様（全スコア共通: 0〜100, 高いほど安全）:
  depth_risk_from_lower(lower_m):
    lower_m <= 0   → 0
    < 0.3          → 20
    < 1.0          → 35
    < 3.0          → 55
    < 5.0          → 70
    < 10.0         → 85
    >= 10.0        → 100

  score_candidate(area_ratio, max_depth_lower_m):
    area_risk = min(100, area_ratio * 100)
    combined  = 0.6 * area_risk + 0.4 * depth_risk_from_lower(max_depth_lower_m)
    → max(10, min(90, round(100 - combined)))

A40_003 浸水深フィールド（自由テキスト）:
  例: "0.3m以上1.0m未満", "10.0m以上", "0m以上0.3m未満", "0.3m以上", etc.
  → unicodedata.normalize('NFKC', ...) で全角→半角正規化後に下限値を抽出

Usage:
  .venv-flood/bin/python scripts/scoring/score-tsunami-v1.py --pref 08 \\
      --output data/processed/tsunami-sample-08.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

METRIC_CRS     = "EPSG:6690"  # JGD2011 / UTM zone 54N（全国一貫CRS）
TSUNAMI_SOURCE = "国土交通省 国土数値情報 津波浸水想定データ A40-2024"
CALC_VERSION   = "tsunami-v1"

RAW_A40  = Path("data/raw/tsunami/A40")
RAW_N03  = Path("data/raw/flood/N03")
N03_DATE = "20240101"


def find_a40_zip(pref: str) -> Path | None:
    """RAW_A40 から A40-*_{pref}_GML.zip を検索して返す（なければ None）。"""
    candidates = sorted(RAW_A40.glob(f"A40-*_{pref}_GML.zip"), reverse=True)
    return candidates[0] if candidates else None


# ---------------------------------------------------------------------------
# Depth parsing
# ---------------------------------------------------------------------------

_DEPTH_RE = re.compile(r"(\d+(?:\.\d+)?)\s*m以上")


def parse_depth_lower_m(raw: str | None) -> float:
    """A40_003 テキストから浸水深下限値 (m) を返す。解析不能 → 0.0。"""
    if not raw:
        return 0.0
    normalized = unicodedata.normalize("NFKC", str(raw)).strip()
    m = _DEPTH_RE.search(normalized)
    if m:
        return float(m.group(1))
    return 0.0


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


def score_candidate(area_ratio: float, max_depth_lower_m: float) -> int:
    area_risk = min(100.0, area_ratio * 100.0)
    drisk     = depth_risk_from_lower(max_depth_lower_m)
    combined  = 0.6 * area_risk + 0.4 * drisk
    return max(10, min(90, round(100 - combined)))


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
# Core computation
# ---------------------------------------------------------------------------

def compute_tsunami_scores(a40_path: Path, n03_path: Path, log_depth_values: bool = True) -> list[dict]:
    import geopandas as gpd
    import pandas as pd

    print(f"Loading A40: {a40_path}", flush=True)
    a40 = load_gml(a40_path)
    print(f"  {len(a40)} ポリゴン, CRS={a40.crs}", flush=True)
    print(f"  列: {list(a40.columns)}", flush=True)

    # A40_003 の実値をログ出力
    if log_depth_values and "A40_003" in a40.columns:
        unique_vals = sorted(a40["A40_003"].dropna().unique().tolist(), key=str)
        print(f"\n--- A40_003 ユニーク値 ({len(unique_vals)}種) ---", flush=True)
        for v in unique_vals:
            parsed = parse_depth_lower_m(str(v))
            print(f"  {v!r:40s} → {parsed} m (下限)", flush=True)
        print("", flush=True)
    elif log_depth_values:
        print("  [warn] A40_003 列が見つかりません。列: {list(a40.columns)}", flush=True)

    print(f"Loading N03: {n03_path}", flush=True)
    n03 = load_gml(n03_path)
    print(f"  {len(n03)} 行, CRS={n03.crs}", flush=True)

    jis_col = find_jis_col(n03)
    print(f"  JISコード列: {jis_col}", flush=True)

    # A40_003 → 浸水深下限値
    if "A40_003" in a40.columns:
        a40 = a40.copy()
        a40["depth_lower_m"] = a40["A40_003"].apply(parse_depth_lower_m)
    else:
        a40 = a40.copy()
        a40["depth_lower_m"] = 0.0

    # N03 dissolve by JIS code
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
    print(f"  自治体数（dissolve後）: {len(n03_muni)}", flush=True)

    # Spatial overlay
    print("Spatial overlay（A40 ∩ N03）実行中…", flush=True)
    joined = gpd.overlay(
        a40_m[["depth_lower_m", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area

    # 自治体別集計
    agg = joined.groupby(jis_col).agg(
        tsunami_area_m2  =("clip_area_m2",   "sum"),
        tsunami_poly_count=("clip_area_m2",  "count"),
        max_depth_lower_m=("depth_lower_m",  "max"),
    ).reset_index()

    # 全自治体 left join
    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg, on=jis_col, how="left")
    result = result.merge(name_df, on=jis_col, how="left")

    result["tsunami_area_m2"]   = result["tsunami_area_m2"].fillna(0.0)
    result["tsunami_poly_count"]= result["tsunami_poly_count"].fillna(0).astype(int)
    result["max_depth_lower_m"] = result["max_depth_lower_m"].fillna(0.0)
    # 複数シナリオの重複で sum > muni_area_m2 になりうる → 1.0 でクランプ
    result["tsunami_area_ratio"]= (result["tsunami_area_m2"] / result["muni_area_m2"]).clip(upper=1.0).round(6)

    today = date.today().isoformat()
    rows: list[dict] = []
    for _, r in result.iterrows():
        has_tsunami = r["max_depth_lower_m"] > 0 or r["tsunami_poly_count"] > 0
        candidate = score_candidate(float(r["tsunami_area_ratio"]), float(r["max_depth_lower_m"]))
        if not has_tsunami:
            candidate = 90
        rows.append({
            "jisCode":               r[jis_col],
            "prefecture":            r.get("prefecture", ""),
            "name":                  r.get("name", ""),
            "tsunamiRiskCandidate":  candidate,
            "tsunamiAreaRatio":      round(float(r["tsunami_area_ratio"]), 6),
            "tsunamiMaxDepthM":      round(float(r["max_depth_lower_m"]), 2),
            "tsunamiPolyCount":      int(r["tsunami_poly_count"]),
            "tsunamiDataStatus":     "scored" if has_tsunami else "no-tsunami-data",
            "tsunamiSource":         TSUNAMI_SOURCE,
            "tsunamiUpdatedAt":      today,
            "calculationVersion":    CALC_VERSION,
        })

    return rows


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

JIS_DIGITS = frozenset("0123456789")

VALID_STATUSES = frozenset(["scored", "no-tsunami-data"])


def validate(rows: list[dict]) -> list[str]:
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

        cand = r.get("tsunamiRiskCandidate")
        if not (isinstance(cand, int) and 10 <= cand <= 90):
            errors.append(f"{tag} tsunamiRiskCandidate: 10〜90整数必須: {cand!r}")

        ratio = r.get("tsunamiAreaRatio", -1)
        if not (0.0 <= ratio <= 1.0):
            errors.append(f"{tag} tsunamiAreaRatio: 0〜1必須: {ratio!r}")

        status = r.get("tsunamiDataStatus", "")
        if status not in VALID_STATUSES:
            errors.append(f"{tag} tsunamiDataStatus: 不正な値: {status!r}")

        if status == "no-tsunami-data" and cand != 90:
            errors.append(f"{tag} no-tsunami-data の tsunamiRiskCandidate は 90 必須: {cand!r}")

        if r.get("calculationVersion") != CALC_VERSION:
            errors.append(f"{tag} calculationVersion: {CALC_VERSION!r} 必須")

    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Tsunami ETL PoC: score-tsunami-v1")
    parser.add_argument("--a40",    help="A40 GML ZIP path")
    parser.add_argument("--n03",    help="N03 GML ZIP path")
    parser.add_argument("--pref",   default="08",
                        help="2桁県コード（--a40/--n03 省略時に自動解決）")
    parser.add_argument("--output", required=True, help="出力 JSON path")
    parser.add_argument("--no-log-depths", action="store_true",
                        help="A40_003 ユニーク値ログを抑制")
    args = parser.parse_args()

    pref     = args.pref.zfill(2)
    a40_path = Path(args.a40) if args.a40 else find_a40_zip(pref)
    if a40_path is None:
        print(f"ERROR: A40 ファイルが見つかりません: {RAW_A40}/A40-*_{pref}_GML.zip", file=sys.stderr)
        print(f"  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-tsunami.py --pref {pref} --download",
              file=sys.stderr)
        sys.exit(1)
    n03_path = Path(args.n03) if args.n03 else RAW_N03 / f"N03-{N03_DATE}_{pref}_GML.zip"

    for p, label in ((a40_path, "A40"), (n03_path, "N03")):
        if not p.exists():
            print(f"ERROR: {label} ファイルが見つかりません: {p}", file=sys.stderr)
            sys.exit(1)

    rows = compute_tsunami_scores(a40_path, n03_path, log_depth_values=not args.no_log_depths)

    # ----- Validation -----
    print("--- バリデーション ---", flush=True)
    errors = validate(rows)
    if errors:
        for e in errors:
            print(f"  ❌ {e}", file=sys.stderr)
        print(f"\nバリデーションエラー {len(errors)} 件。出力を中止します。", file=sys.stderr)
        sys.exit(1)
    print(f"  ✅ {len(rows)} 件 全バリデーション通過", flush=True)

    # ----- 統計 -----
    scored    = [r for r in rows if r["tsunamiDataStatus"] == "scored"]
    no_data   = [r for r in rows if r["tsunamiDataStatus"] == "no-tsunami-data"]
    candidates = [r["tsunamiRiskCandidate"] for r in rows]

    print(f"\n=== tsunami-v1 サンプル統計 (pref={pref}) ===")
    print(f"  自治体数               : {len(rows)}")
    print(f"  scored                 : {len(scored)}")
    print(f"  no-tsunami-data        : {len(no_data)}")
    if candidates:
        print(f"  tsunamiRiskCandidate   : min={min(candidates)} / max={max(candidates)}"
              f" / mean={sum(candidates)/len(candidates):.1f}")
    if scored:
        ratios = [r["tsunamiAreaRatio"] for r in scored]
        depths = [r["tsunamiMaxDepthM"] for r in scored]
        print(f"  tsunamiAreaRatio       : min={min(ratios):.4f} / max={max(ratios):.4f}"
              f" / mean={sum(ratios)/len(ratios):.4f}")
        print(f"  tsunamiMaxDepthM       : min={min(depths):.1f} / max={max(depths):.1f}")

    top5_risky = sorted(scored, key=lambda r: r["tsunamiRiskCandidate"])[:5]
    print(f"\n  最危険上位5自治体（tsunamiRiskCandidate 昇順）:")
    for r in top5_risky:
        print(f"    [{r['jisCode']}] {r['name']}"
              f" | candidate={r['tsunamiRiskCandidate']}"
              f" | areaRatio={r['tsunamiAreaRatio']:.3f}"
              f" | maxDepthM={r['tsunamiMaxDepthM']:.1f}")

    top5_safe = sorted(scored, key=lambda r: r["tsunamiRiskCandidate"], reverse=True)[:5]
    print(f"\n  最安全上位5自治体（tsunamiRiskCandidate 降順）:")
    for r in top5_safe:
        print(f"    [{r['jisCode']}] {r['name']}"
              f" | candidate={r['tsunamiRiskCandidate']}"
              f" | areaRatio={r['tsunamiAreaRatio']:.3f}"
              f" | maxDepthM={r['tsunamiMaxDepthM']:.1f}")

    # ----- 出力 -----
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {out_path} ({len(rows)} 件, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
