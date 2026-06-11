"""
score-flood-v1.py — A31×N03 空間結合 → floodRiskCandidate 算出

スコア仕様（全スコア共通: 0〜100, 高いほど安全）:
  - 浸水なし      → 90
  - depthFactor   = maxDepthDanger / 5            (0.0〜1.0)
  - areaFactor    = min(1.0, floodAreaRatio / 0.3) (0.0〜1.0、30%で飽和)
  - combined      = depthFactor*0.5 + areaFactor*0.5
  - candidate     = round(90 - combined * 80)      → [10, 90]

A31_001 浸水深コード:
  11=0〜0.5m, 12=0.5〜1m, 13=1〜2m, 14=2〜5m, 15=5m超

Usage:
  python scripts/scoring/score-flood-v1.py \
      --a31  data/raw/flood/A31/A31-12_08_GML.zip \
      --n03  data/raw/flood/N03/N03-20240101_08_GML.zip \
      --output data/processed/flood-scores-sample-08.json

  --pref CODE  2桁県コード（自動ファイルパス解決時）
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

DEPTH_DANGER: dict[int, int] = {11: 1, 12: 2, 13: 3, 14: 4, 15: 5}
METRIC_CRS   = "EPSG:6690"      # JGD2011 / UTM zone 54N（全国一貫CRS）
FLOOD_SOURCE = "国土交通省 国土数値情報 浸水想定区域データ A31-12"
CALC_VERSION = "flood-v1-sample"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_gml(zip_path: Path):
    import geopandas as gpd
    import zipfile

    try:
        gdf = gpd.read_file(f"zip://{zip_path.resolve()}")
        return gdf
    except Exception:
        with zipfile.ZipFile(zip_path) as z:
            gml_files = [n for n in z.namelist() if n.endswith((".xml", ".gml"))]
        if not gml_files:
            raise RuntimeError(f"GML/XML not found in {zip_path}")
        return gpd.read_file(f"zip://{zip_path.resolve()}!{gml_files[0]}")


def find_jis_col(gdf) -> str:
    for c in ("N03_007", "N03_007_", "jiscode"):
        if c in gdf.columns:
            return c
    raise RuntimeError(f"JISコード列が見つかりません。列: {list(gdf.columns)}")


def score_candidate(max_depth_danger: int, flood_area_ratio: float) -> int:
    if max_depth_danger == 0:
        return 90
    depth_f = max_depth_danger / 5.0
    area_f  = min(1.0, flood_area_ratio / 0.3)
    combined = depth_f * 0.5 + area_f * 0.5
    return max(10, min(90, round(90 - combined * 80)))


# ---------------------------------------------------------------------------
# Spatial join & aggregation
# ---------------------------------------------------------------------------

def compute_flood_scores(a31_path: Path, n03_path: Path) -> list[dict]:
    import geopandas as gpd
    import pandas as pd

    print(f"Loading A31: {a31_path}")
    a31 = load_gml(a31_path)
    print(f"  {len(a31)} ポリゴン, CRS={a31.crs}")

    print(f"Loading N03: {n03_path}")
    n03 = load_gml(n03_path)
    print(f"  {len(n03)} 行, CRS={n03.crs}")

    jis_col = find_jis_col(n03)
    print(f"  JISコード列: {jis_col}")

    # A31_001 を数値化・深さ危険度マッピング
    a31["depth_code"]   = pd.to_numeric(a31["A31_001"], errors="coerce").astype("Int64")
    a31["depth_danger"] = a31["depth_code"].map(DEPTH_DANGER).fillna(0).astype(int)

    # N03 dissolve by JIS code → 自治体ポリゴン + 名前取得
    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    # 名前を jisCode ごとに first で保持
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    # 投影変換（メートル系）
    a31_m = a31.to_crs(METRIC_CRS)
    n03_m = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area
    print(f"  自治体数（dissolve後）: {len(n03_muni)}")

    # Spatial overlay（intersection）
    print("Spatial overlay（A31 ∩ N03）実行中…")
    joined = gpd.overlay(
        a31_m[["depth_code", "depth_danger", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area

    # 自治体別集計
    agg = joined.groupby(jis_col).agg(
        flood_area_m2   =("clip_area_m2",  "sum"),
        flood_poly_count=("clip_area_m2",  "count"),
        max_depth_code  =("depth_code",    "max"),
        max_depth_danger=("depth_danger",  "max"),
        # 面積加重平均: sum(danger * area) / sum(area)
        _wdsum          =pd.NamedAgg(
            column="clip_area_m2",
            aggfunc=lambda s: (joined.loc[s.index, "depth_danger"] * s).sum(),
        ),
    ).reset_index()
    agg["mean_depth_score"] = (agg["_wdsum"] / agg["flood_area_m2"]).round(4)
    agg = agg.drop(columns=["_wdsum"])

    # 全自治体 left join
    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg, on=jis_col, how="left")
    result = result.merge(name_df, on=jis_col, how="left")

    result["flood_area_m2"]    = result["flood_area_m2"].fillna(0.0)
    result["flood_poly_count"] = result["flood_poly_count"].fillna(0).astype(int)
    result["max_depth_code"]   = result["max_depth_code"].fillna(0).astype(int)
    result["max_depth_danger"] = result["max_depth_danger"].fillna(0).astype(int)
    result["mean_depth_score"] = result["mean_depth_score"].fillna(0.0)
    # A31は複数河川シナリオが重複するため sum > muni_area_m2 になりうる → 1.0 でクランプ
    result["flood_area_ratio"] = (result["flood_area_m2"] / result["muni_area_m2"]).clip(upper=1.0).round(6)

    today = date.today().isoformat()
    rows: list[dict] = []
    for _, r in result.iterrows():
        has_flood = r["max_depth_code"] > 0
        candidate = score_candidate(int(r["max_depth_danger"]), float(r["flood_area_ratio"]))
        rows.append({
            "jisCode":              r[jis_col],
            "prefecture":           r.get("prefecture", ""),
            "name":                 r.get("name", ""),
            "floodRiskCandidate":   candidate,
            "maxDepthCode":         int(r["max_depth_code"]),
            "maxDepthDanger":       int(r["max_depth_danger"]),
            "meanDepthScore":       round(float(r["mean_depth_score"]), 4),
            "floodAreaRatio":       round(float(r["flood_area_ratio"]), 6),
            "floodPolyCount":       int(r["flood_poly_count"]),
            "floodDataStatus":      "scored" if has_flood else "no-flood-data",
            "floodSource":          FLOOD_SOURCE,
            "floodUpdatedAt":       today,
            "calculationVersion":   CALC_VERSION,
        })

    return rows


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

JIS_DIGITS = set("0123456789")

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

        cand = r.get("floodRiskCandidate")
        if not (isinstance(cand, int) and 10 <= cand <= 90):
            errors.append(f"{tag} floodRiskCandidate: 10〜90整数必須: {cand!r}")

        ratio = r.get("floodAreaRatio", -1)
        if not (0.0 <= ratio <= 1.0):
            errors.append(f"{tag} floodAreaRatio: 0〜1必須: {ratio!r}")

        mdc = r.get("maxDepthCode", -1)
        if mdc not in (0, 11, 12, 13, 14, 15):
            errors.append(f"{tag} maxDepthCode: {{0,11〜15}}必須: {mdc!r}")

        mdd = r.get("maxDepthDanger", -1)
        if mdd not in (0, 1, 2, 3, 4, 5):
            errors.append(f"{tag} maxDepthDanger: 0〜5必須: {mdd!r}")

        status = r.get("floodDataStatus", "")
        if status not in ("scored", "no-flood-data"):
            errors.append(f"{tag} floodDataStatus: 不正な値: {status!r}")

        if status == "no-flood-data":
            if mdc != 0 or r.get("floodPolyCount", -1) != 0:
                errors.append(f"{tag} no-flood-data なのに flood データあり")
            if cand != 90:
                errors.append(f"{tag} no-flood-data の floodRiskCandidate は 90 必須: {cand!r}")

        if r.get("calculationVersion") != CALC_VERSION:
            errors.append(f"{tag} calculationVersion: {CALC_VERSION!r} 必須")

    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Flood ETL Step2: score-flood-v1")
    parser.add_argument("--a31",    help="A31 GML ZIP path")
    parser.add_argument("--n03",    help="N03 GML ZIP path")
    parser.add_argument("--pref",   default="08",
                        help="2桁県コード（--a31/--n03 省略時に自動解決）")
    parser.add_argument("--output", required=True, help="出力 JSON path")
    args = parser.parse_args()

    pref     = args.pref.zfill(2)
    a31_path = Path(args.a31) if args.a31 else Path(f"data/raw/flood/A31/A31-12_{pref}_GML.zip")
    n03_path = Path(args.n03) if args.n03 else Path(f"data/raw/flood/N03/N03-20240101_{pref}_GML.zip")

    for p in (a31_path, n03_path):
        if not p.exists():
            print(f"ERROR: ファイルが見つかりません: {p}", file=sys.stderr)
            print(f"  npm run fetch:flood:sample を先に実行してください。", file=sys.stderr)
            sys.exit(1)

    rows = compute_flood_scores(a31_path, n03_path)

    # ----- Validation -----
    print("\n--- バリデーション ---")
    errors = validate(rows)
    if errors:
        for e in errors:
            print(f"  ❌ {e}", file=sys.stderr)
        print(f"\nバリデーションエラー {len(errors)} 件。出力を中止します。", file=sys.stderr)
        sys.exit(1)
    print(f"  ✅ {len(rows)} 件 全バリデーション通過")

    # ----- 統計 -----
    scored      = [r for r in rows if r["floodDataStatus"] == "scored"]
    no_flood    = [r for r in rows if r["floodDataStatus"] == "no-flood-data"]
    candidates  = [r["floodRiskCandidate"] for r in rows]
    ratios      = [r["floodAreaRatio"] for r in scored]

    print(f"\n=== flood-v1 サンプル統計 (pref={pref}) ===")
    print(f"  自治体数            : {len(rows)}")
    print(f"  scored              : {len(scored)}")
    print(f"  no-flood-data       : {len(no_flood)}")
    print(f"  floodRiskCandidate  : min={min(candidates)} / max={max(candidates)} / mean={sum(candidates)/len(candidates):.1f}")
    if ratios:
        print(f"  floodAreaRatio      : min={min(ratios):.4f} / max={max(ratios):.4f} / mean={sum(ratios)/len(ratios):.4f}")

    top5_risky = sorted(scored, key=lambda r: r["floodRiskCandidate"])[:5]
    print(f"\n  最危険上位5自治体（floodRiskCandidate 昇順）:")
    for r in top5_risky:
        print(f"    [{r['jisCode']}] {r['name']}"
              f" | candidate={r['floodRiskCandidate']}"
              f" | maxDepthCode={r['maxDepthCode']}"
              f" | areaRatio={r['floodAreaRatio']:.3f}")

    top5_safe = sorted(scored, key=lambda r: r["floodRiskCandidate"], reverse=True)[:5]
    print(f"\n  最安全上位5自治体（floodRiskCandidate 降順）:")
    for r in top5_safe:
        print(f"    [{r['jisCode']}] {r['name']}"
              f" | candidate={r['floodRiskCandidate']}"
              f" | maxDepthCode={r['maxDepthCode']}"
              f" | areaRatio={r['floodAreaRatio']:.3f}")

    # ----- 出力 -----
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {out_path} ({len(rows)} 件, {size_kb:.1f} KB)")
    print(f"   municipalities.json は変更されていません。")


if __name__ == "__main__":
    main()
