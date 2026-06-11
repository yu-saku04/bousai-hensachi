"""
convert-a31-to-municipalities-csv.py — Spatial join A31 flood polygons onto N03 municipality boundaries

For each municipality (JIS 5-digit code), computes:
  - floodAreaRatio   : flooded polygon area / municipality area  (0.0–1.0)
  - maxFloodDepthCat : max A31_001 category found in the municipality (0–5)
  - floodPolyCount   : number of flood polygon intersections

Usage:
  python scripts/converters/convert-a31-to-municipalities-csv.py \
      --a31  data/raw/flood/A31/A31-12_08_GML.zip \
      --n03  data/raw/flood/N03/N03-20240101_08_GML.zip \
      [--output data/processed/flood_08.csv] \
      [--dry-run]

  --dry-run   print GML schema only, do not compute or write
"""

import argparse
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="A31→municipality flood CSV")
    parser.add_argument("--a31",    required=True, help="A31 GML ZIP path")
    parser.add_argument("--n03",    required=True, help="N03 GML ZIP path")
    parser.add_argument("--output", default=None,  help="Output CSV path")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print schema and first rows; do not write")
    args = parser.parse_args()

    try:
        import geopandas as gpd
        import pandas as pd
    except ImportError:
        print("ERROR: geopandas not found. Activate .venv-flood first.", file=sys.stderr)
        sys.exit(1)

    a31_path = Path(args.a31)
    n03_path = Path(args.n03)

    if not a31_path.exists():
        print(f"ERROR: A31 file not found: {a31_path}", file=sys.stderr)
        sys.exit(1)
    if not n03_path.exists():
        print(f"ERROR: N03 file not found: {n03_path}", file=sys.stderr)
        sys.exit(1)

    # -------------------------------------------------------------------------
    # Load A31
    # -------------------------------------------------------------------------
    print(f"Loading A31: {a31_path}")
    try:
        a31 = gpd.read_file(f"zip://{a31_path.resolve()}")
    except Exception as e:
        # Some ZIPs contain nested GML; try listing layers
        import zipfile, fiona
        with zipfile.ZipFile(a31_path) as z:
            gml_files = [n for n in z.namelist() if n.endswith(".xml") or n.endswith(".gml")]
        print(f"  GML/XML files in ZIP: {gml_files}")
        if not gml_files:
            print(f"ERROR: no GML/XML found in {a31_path}", file=sys.stderr)
            sys.exit(1)
        a31 = gpd.read_file(f"zip://{a31_path.resolve()}!{gml_files[0]}")

    print(f"  rows   : {len(a31)}")
    print(f"  CRS    : {a31.crs}")
    print(f"  columns: {list(a31.columns)}")
    print(f"  geom types: {a31.geometry.geom_type.value_counts().to_dict()}")
    if len(a31) > 0:
        print(f"\n  First row:\n{a31.iloc[0].to_string()}\n")

    if args.dry_run:
        # -------------------------------------------------------------------------
        # Load N03 in dry-run too, just to confirm schema
        # -------------------------------------------------------------------------
        print(f"Loading N03: {n03_path}")
        try:
            n03 = gpd.read_file(f"zip://{n03_path.resolve()}")
        except Exception:
            import zipfile
            with zipfile.ZipFile(n03_path) as z:
                gml_files = [n for n in z.namelist() if n.endswith(".xml") or n.endswith(".gml")]
            n03 = gpd.read_file(f"zip://{n03_path.resolve()}!{gml_files[0]}")

        print(f"  rows   : {len(n03)}")
        print(f"  CRS    : {n03.crs}")
        print(f"  columns: {list(n03.columns)}")
        if len(n03) > 0:
            print(f"\n  First row:\n{n03.iloc[0].to_string()}\n")

        # Show unique depth categories if A31_001 present
        if "A31_001" in a31.columns:
            print(f"  A31_001 value counts:\n{a31['A31_001'].value_counts().sort_index().to_string()}\n")

        print("[dry-run] Schema check complete. No output written.")
        return

    # -------------------------------------------------------------------------
    # Load N03
    # -------------------------------------------------------------------------
    print(f"Loading N03: {n03_path}")
    try:
        n03 = gpd.read_file(f"zip://{n03_path.resolve()}")
    except Exception:
        import zipfile
        with zipfile.ZipFile(n03_path) as z:
            gml_files = [n for n in z.namelist() if n.endswith(".xml") or n.endswith(".gml")]
        n03 = gpd.read_file(f"zip://{n03_path.resolve()}!{gml_files[0]}")

    print(f"  rows   : {len(n03)}")
    print(f"  CRS    : {n03.crs}")

    # -------------------------------------------------------------------------
    # Reproject to a metric CRS (JGD2011 / UTM zone 54N) for area calc
    # -------------------------------------------------------------------------
    METRIC_CRS = "EPSG:6690"  # JGD2011 / Japan Plane Rectangular CS X (rough national)
    # Use 6691 for Kanto; good enough for national consistency
    # Actually use JGD2011 / UTM zone 54N (EPSG:6690) as national metric CRS
    a31_m = a31.to_crs(METRIC_CRS)
    n03_m = n03.to_crs(METRIC_CRS)

    # -------------------------------------------------------------------------
    # Identify JIS code column in N03
    # -------------------------------------------------------------------------
    jis_col = None
    for candidate in ("N03_007", "N03_007_", "jiscode", "citycode"):
        if candidate in n03_m.columns:
            jis_col = candidate
            break
    if jis_col is None:
        print(f"ERROR: cannot find JIS code column in N03. Columns: {list(n03_m.columns)}", file=sys.stderr)
        sys.exit(1)
    print(f"  JIS code column: {jis_col}")

    # Dissolve N03 by JIS code to merge sub-rows (N03 has one row per oaza boundary)
    n03_muni = n03_m[[jis_col, "geometry"]].copy()
    n03_muni = n03_muni[n03_muni[jis_col].notna() & (n03_muni[jis_col] != "")].copy()
    n03_muni = n03_muni.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area
    print(f"  municipalities after dissolve: {len(n03_muni)}")

    # -------------------------------------------------------------------------
    # Identify flood depth category column in A31
    # -------------------------------------------------------------------------
    depth_col = None
    for candidate in ("A31_001", "A31_001_", "depth", "rank"):
        if candidate in a31_m.columns:
            depth_col = candidate
            break

    # -------------------------------------------------------------------------
    # Spatial join: overlay (intersection) to clip flood polys to each muni
    # -------------------------------------------------------------------------
    print("Running spatial overlay (intersection) …")
    joined = gpd.overlay(a31_m, n03_muni, how="intersection", keep_geom_type=False)
    joined["flood_area_m2"] = joined.geometry.area

    # -------------------------------------------------------------------------
    # Aggregate per municipality
    # -------------------------------------------------------------------------
    agg: dict = {"flood_area_m2": "sum", "geometry": "count"}
    if depth_col:
        joined[depth_col] = pd.to_numeric(joined[depth_col], errors="coerce")
        agg[depth_col] = "max"

    grouped = joined.groupby(jis_col).agg(agg).reset_index()
    grouped.columns = [jis_col, "flood_area_m2", "flood_poly_count"] + (["max_depth_cat"] if depth_col else [])

    result = n03_muni[[jis_col, "muni_area_m2"]].merge(grouped, on=jis_col, how="left")
    result["flood_area_m2"]   = result["flood_area_m2"].fillna(0)
    result["flood_poly_count"] = result["flood_poly_count"].fillna(0).astype(int)
    result["flood_area_ratio"] = (result["flood_area_m2"] / result["muni_area_m2"]).round(6)

    if depth_col:
        result["max_flood_depth_cat"] = result["max_depth_cat"].fillna(0).astype(int)
        result = result.drop(columns=["max_depth_cat"])

    result = result.rename(columns={jis_col: "jisCode"})
    result = result[["jisCode", "flood_area_ratio", "flood_poly_count"]
                    + (["max_flood_depth_cat"] if depth_col else [])]

    print(f"\nResult preview:\n{result.head(10).to_string(index=False)}\n")
    print(f"Summary:\n  municipalities: {len(result)}")
    print(f"  with flood data: {(result['flood_area_ratio'] > 0).sum()}")
    print(f"  flood_area_ratio: min={result['flood_area_ratio'].min():.4f} "
          f"max={result['flood_area_ratio'].max():.4f} "
          f"mean={result['flood_area_ratio'].mean():.4f}")

    # -------------------------------------------------------------------------
    # Write
    # -------------------------------------------------------------------------
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        result.to_csv(out_path, index=False)
        print(f"\n✅ Written: {out_path} ({len(result)} rows)")
    else:
        print("\n(No --output specified; results not saved)")


if __name__ == "__main__":
    main()
