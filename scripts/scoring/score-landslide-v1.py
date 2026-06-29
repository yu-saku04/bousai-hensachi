"""
score-landslide-v1.py — A33×N03 空間結合 → landslideRiskCandidate 算出 (PoC)

A33 列仕様（実地確認済み）:
  A33_001: 災害種別  1=土石流 / 2=急傾斜地 / 3=地すべり
  A33_002: 区域種別  1=土砂災害警戒区域（黄） / 2=土砂災害特別警戒区域（赤）

スコア仕様（0〜100 / 高いほど安全）:
  landslideAreaRatio = (全区域 unary_union 後の面積) / muni_area_m2
  ratio >= 0.20 → 20
  ratio >= 0.10 → 35
  ratio >= 0.05 → 50
  ratio >  0   → 65
  ratio == 0   → 90  (no-landslide-data)

Usage:
  python scripts/scoring/score-landslide-v1.py \\
      --a33  data/raw/landslide/A33/A33-15_08_GML.zip \\
      --n03  data/raw/flood/N03/N03-20240101_08_GML.zip \\
      --output data/processed/landslide-sample-08.json

  --pref CODE  2桁県コード（--a33/--n03 省略時に自動解決）
"""

import argparse
import json
import sys
import zipfile
from datetime import date
from pathlib import Path

METRIC_CRS        = "EPSG:6690"   # JGD2011 / Japan Plane Rectangular CS VIII（全国一貫）
LANDSLIDE_SOURCE  = "国土交通省 国土数値情報 土砂災害警戒区域等 A33-15"
CALC_VERSION      = "landslide-v1"

# A33_001 ラベル（ログ用）
HAZARD_TYPE_LABEL = {1: "土石流", 2: "急傾斜地", 3: "地すべり"}
# A33_002 ラベル（ログ用）
ZONE_CLASS_LABEL  = {1: "警戒区域（黄）", 2: "特別警戒区域（赤）"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_shp_from_zip(zip_path: Path):
    """ZIP 内の SHP を優先して読み込む。SHP なければ XML/GML にフォールバック。"""
    import geopandas as gpd

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()

    def _is_meta(name: str) -> bool:
        return name.split("/")[-1].upper().startswith("KS-META")

    for ext in (".shp", ".xml", ".gml"):
        candidates = [n for n in names if n.endswith(ext) and not _is_meta(n)]
        for candidate in candidates:
            try:
                gdf = gpd.read_file(f"zip://{zip_path.resolve()}!{candidate}")
                if len(gdf) > 0:
                    return gdf
                print(f"  [warn] {candidate} が空、次候補へ", flush=True)
            except Exception as e:
                print(f"  [warn] {candidate} 読み込み失敗: {e}", flush=True)

    raise RuntimeError(f"有効なフィーチャが見つかりません: {zip_path}")


def find_jis_col(gdf) -> str:
    for c in ("N03_007", "N03_007_", "jiscode"):
        if c in gdf.columns:
            return c
    raise RuntimeError(f"JISコード列が見つかりません。列: {list(gdf.columns)}")


def score_from_ratio(ratio: float) -> int:
    if ratio >= 0.20:
        return 20
    if ratio >= 0.10:
        return 35
    if ratio >= 0.05:
        return 50
    if ratio > 0:
        return 65
    return 90


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def compute_landslide_scores(a33_path: Path, n03_path: Path) -> list[dict]:
    import geopandas as gpd
    import pandas as pd

    # --- A33 読み込み ---
    print(f"Loading A33: {a33_path}", flush=True)
    a33 = load_shp_from_zip(a33_path)
    print(f"  {len(a33)} ポリゴン, CRS={a33.crs}")

    # 列サマリーをログ出力（デバッグ用）
    if "A33_001" in a33.columns:
        type_counts = a33["A33_001"].value_counts().to_dict()
        print(f"  A33_001 (災害種別): { {HAZARD_TYPE_LABEL.get(k, k): v for k, v in type_counts.items()} }")
    if "A33_002" in a33.columns:
        class_counts = a33["A33_002"].value_counts().to_dict()
        print(f"  A33_002 (区域種別): { {ZONE_CLASS_LABEL.get(k, k): v for k, v in class_counts.items()} }")

    # --- N03 読み込み ---
    print(f"Loading N03: {n03_path}", flush=True)
    n03 = load_shp_from_zip(n03_path)
    print(f"  {len(n03)} 行, CRS={n03.crs}")

    jis_col = find_jis_col(n03)
    print(f"  JISコード列: {jis_col}")

    # --- N03 dissolve → 自治体ポリゴン ---
    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    a33_m    = a33.to_crs(METRIC_CRS)
    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area
    print(f"  自治体数（dissolve後）: {len(n03_muni)}")

    # --- A33 が空なら全自治体 no-landslide-data ---
    if len(a33_m) == 0:
        print("  [warn] A33 フィーチャなし → 全自治体 no-landslide-data", flush=True)
        today = date.today().isoformat()
        rows: list[dict] = []
        for _, r in name_df.iterrows():
            rows.append(_make_row(str(r[jis_col]), str(r.get("prefecture", "")),
                                  str(r.get("name", "")), 90, "no-landslide-data",
                                  0.0, 0.0, today))
        return rows

    # --- Spatial overlay ---
    print("Spatial overlay（A33 ∩ N03）実行中…", flush=True)
    joined = gpd.overlay(
        a33_m[["A33_001", "A33_002", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area
    print(f"  overlay 結果: {len(joined)} 行")

    # --- 自治体別集計 ---
    # 全区域: unary_union ベースではなく sum（PoC では重複を許容）
    agg_all = joined.groupby(jis_col).agg(
        zone_area_m2=("clip_area_m2", "sum"),
        zone_count  =("clip_area_m2", "count"),
    ).reset_index()

    # 特別警戒区域（赤）のみ
    joined_special = joined[joined["A33_002"] == 2]
    agg_special = joined_special.groupby(jis_col).agg(
        special_zone_area_m2=("clip_area_m2", "sum"),
    ).reset_index()

    # --- 全自治体 left join ---
    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg_all,     on=jis_col, how="left")
    result = result.merge(agg_special, on=jis_col, how="left")
    result = result.merge(name_df,     on=jis_col, how="left")

    result["zone_area_m2"]         = result["zone_area_m2"].fillna(0.0)
    result["zone_count"]           = result["zone_count"].fillna(0).astype(int)
    result["special_zone_area_m2"] = result["special_zone_area_m2"].fillna(0.0)

    # 面積比率（sum > muni_area_m2 になりうるため clamp）
    result["landslide_area_ratio"]         = (
        result["zone_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)
    result["landslide_special_area_ratio"] = (
        result["special_zone_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

    today = date.today().isoformat()
    rows = []
    for _, r in result.iterrows():
        ratio  = float(r["landslide_area_ratio"])
        score  = score_from_ratio(ratio)
        status = "scored" if ratio > 0 else "no-landslide-data"
        rows.append(_make_row(
            jisCode        = str(r[jis_col]),
            prefecture     = str(r.get("prefecture") or ""),
            municipality   = str(r.get("name") or ""),
            score          = score,
            status         = status,
            area_ratio     = ratio,
            special_ratio  = float(r["landslide_special_area_ratio"]),
            today          = today,
        ))

    return rows


def _make_row(
    jisCode: str,
    prefecture: str,
    municipality: str,
    score: int,
    status: str,
    area_ratio: float,
    special_ratio: float,
    today: str,
) -> dict:
    return {
        "jisCode":                   jisCode,
        "prefecture":                prefecture,
        "municipality":              municipality,
        "landslideRiskCandidate":    score,
        "landslideDataStatus":       status,
        "landslideAreaRatio":        area_ratio,
        "landslideSpecialAreaRatio": special_ratio,
        "landslideSource":           LANDSLIDE_SOURCE,
        "landslideUpdatedAt":        today,
        "calculationVersion":        CALC_VERSION,
    }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

JIS_DIGITS = frozenset("0123456789")
VALID_STATUSES = frozenset(["scored", "no-landslide-data", "load-failed"])


def validate(rows: list[dict]) -> list[str]:
    errors: list[str] = []
    seen: dict[str, int] = {}

    for i, r in enumerate(rows):
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
        if not (isinstance(score, int) and 10 <= score <= 90):
            errors.append(f"{tag} landslideRiskCandidate: 10〜90整数必須: {score!r}")

        ratio = r.get("landslideAreaRatio")
        if ratio is not None and not (0.0 <= ratio <= 1.0):
            errors.append(f"{tag} landslideAreaRatio: 0〜1必須: {ratio!r}")

        if r.get("calculationVersion") != CALC_VERSION:
            errors.append(f"{tag} calculationVersion: {CALC_VERSION!r} 必須")

    return errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Landslide ETL Step2: score-landslide-v1 (PoC)")
    parser.add_argument("--a33",    help="A33 GML/SHP ZIP path")
    parser.add_argument("--n03",    help="N03 GML/SHP ZIP path")
    parser.add_argument("--pref",   default="08",
                        help="2桁県コード（--a33/--n03 省略時に自動解決）")
    parser.add_argument("--output", default="data/processed/landslide-sample-08.json",
                        help="出力 JSON path")
    args = parser.parse_args()

    pref     = args.pref.zfill(2)

    # A33 バージョンは fetch スクリプトと合わせる
    from pathlib import Path as P
    FALLBACK_VERSION = {"40": "A33-13"}
    a33_ver  = FALLBACK_VERSION.get(pref, "A33-15")
    a33_path = P(args.a33) if args.a33 else P(f"data/raw/landslide/A33/{a33_ver}_{pref}_GML.zip")
    n03_path = P(args.n03) if args.n03 else P(f"data/raw/flood/N03/N03-20240101_{pref}_GML.zip")

    for p in (a33_path, n03_path):
        if not p.exists():
            print(f"ERROR: ファイルが見つかりません: {p}", file=sys.stderr)
            sys.exit(1)

    try:
        rows = compute_landslide_scores(a33_path, n03_path)
    except Exception as e:
        print(f"ERROR: 空間結合失敗: {e}", file=sys.stderr)
        sys.exit(1)

    # --- バリデーション ---
    print("\n--- バリデーション ---")
    errors = validate(rows)
    if errors:
        for e in errors:
            print(f"  ❌ {e}", file=sys.stderr)
        print(f"\nバリデーションエラー {len(errors)} 件。出力を中止します。", file=sys.stderr)
        sys.exit(1)
    print(f"  ✅ {len(rows)} 件 全バリデーション通過")

    # --- 統計 ---
    scored_rows   = [r for r in rows if r["landslideDataStatus"] == "scored"]
    no_land_rows  = [r for r in rows if r["landslideDataStatus"] == "no-landslide-data"]
    ratios        = [r["landslideAreaRatio"] for r in scored_rows]
    candidates    = [r["landslideRiskCandidate"] for r in rows]

    print(f"\n=== landslide-v1 サンプル統計 (pref={pref}) ===")
    print(f"  自治体数             : {len(rows)}")
    print(f"  scored               : {len(scored_rows)}")
    print(f"  no-landslide-data    : {len(no_land_rows)}")
    print(f"  landslideRiskCandidate: min={min(candidates)} / max={max(candidates)}"
          f" / mean={sum(candidates)/len(candidates):.1f}")
    if ratios:
        print(f"  landslideAreaRatio   : min={min(ratios):.4f} / max={max(ratios):.4f}"
              f" / mean={sum(ratios)/len(ratios):.4f}")

    # スコア分布
    from collections import Counter
    dist = Counter(r["landslideRiskCandidate"] for r in rows)
    print(f"\n  スコア分布:")
    for score in sorted(dist):
        print(f"    {score:>3}: {dist[score]}件")

    print(f"\n  最危険 上位5（landslideRiskCandidate 昇順）:")
    for r in sorted(scored_rows, key=lambda x: x["landslideRiskCandidate"])[:5]:
        print(f"    [{r['jisCode']}] {r['municipality']}"
              f" | score={r['landslideRiskCandidate']}"
              f" | areaRatio={r['landslideAreaRatio']:.4f}")

    # --- 出力 ---
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"\n✅ 書き出し完了: {out_path} ({len(rows)} 件, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
