"""
score-flood-v1-all.py — 全国47都道府県 flood-v1 スコア算出（再開可能版）

処理フロー:
  1. 都道府県ごとに A31×N03 を空間結合してスコア算出
  2. 結果を data/processed/flood/by-pref/flood-{pref}.json に即時保存
  3. 全県完了後（または --merge-only 時）に by-pref/ を結合して flood-scores.json を生成
  4. 最終 JSON で municipalities.json 1918 件と突合し、未処理は "not-processed" で補完

使い方（分割実行例）:
  # Ibaraki 単体テスト
  .venv-flood/bin/python scripts/scoring/score-flood-v1-all.py --pref-list 08

  # 東北地方まとめて処理（skip-existing で再開可能）
  .venv-flood/bin/python scripts/scoring/score-flood-v1-all.py \\
      --pref-start 02 --pref-end 07 --skip-existing

  # 全国
  .venv-flood/bin/python scripts/scoring/score-flood-v1-all.py

  # by-pref/ を結合して最終 JSON を生成（処理なし）
  .venv-flood/bin/python scripts/scoring/score-flood-v1-all.py --merge-only
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

ALL_PREFS    = [f"{i:02d}" for i in range(1, 48)]
METRIC_CRS   = "EPSG:6690"   # JGD2011 / UTM zone 54N（全国一貫 metric CRS）
FLOOD_SOURCE = "国土交通省 国土数値情報 浸水想定区域データ A31-12"
CALC_VERSION = "flood-v1"

A31_VERSION = "A31-12"
N03_DATE    = "20240101"
N03_YEAR    = "N03-2024"
BASE_URL    = "https://nlftp.mlit.go.jp/ksj/gml/data"

# 出力 JSON に出現するステータス値（"download-failed" は by-pref には書かれず
# merge 時に "not-processed" として補完されるため含まない）
VALID_STATUSES = frozenset(["scored", "no-flood-data", "not-processed"])
JIS_DIGITS     = frozenset("0123456789")

RAW_A31   = Path("data/raw/flood/A31")
RAW_N03   = Path("data/raw/flood/N03")
BY_PREF   = Path("data/processed/flood/by-pref")
MUNI_JSON = Path("src/data/municipalities.json")

# ---------------------------------------------------------------------------
# A31_001 depth code helpers
# ---------------------------------------------------------------------------

# A31_001 コード体系: 1の位=深さ区分(1〜5), 10の位=洪水種別(1=計画規模,2=想定最大規模 等)
# 深さ区分: 1=0〜0.5m, 2=0.5〜1m, 3=1〜2m, 4=2〜5m, 5=5m超
def depth_danger_from_code(code: int) -> int:
    """A31_001コードの1の位から危険度 1〜5 を返す。1の位が 1〜5 以外なら 0。"""
    danger = code % 10
    return danger if 1 <= danger <= 5 else 0

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

def a31_url(pref: str) -> str:
    return f"{BASE_URL}/A31/{A31_VERSION}/{A31_VERSION}_{pref}_GML.zip"

def n03_url(pref: str) -> str:
    return f"{BASE_URL}/N03/{N03_YEAR}/N03-{N03_DATE}_{pref}_GML.zip"

def a31_zip(pref: str) -> Path:
    return RAW_A31 / f"{A31_VERSION}_{pref}_GML.zip"

def n03_zip(pref: str) -> Path:
    return RAW_N03 / f"N03-{N03_DATE}_{pref}_GML.zip"

def pref_json(pref: str) -> Path:
    return BY_PREF / f"flood-{pref}.json"

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_zip(url: str, dest: Path) -> str:
    """Returns 'ok' | 'skip' | 'not-found' | 'error-{code}'.

    一時ファイル (.tmp) にダウンロードし、成功後に dest へリネームする。
    中断・失敗時は .tmp を削除するため、破損ファイルが dest に残らない。
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
    """ZIP 内の GML/XML または shapefile を読み込む。"""
    import geopandas as gpd
    import zipfile

    # まず ZIP の整合性を確認
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
    except zipfile.BadZipFile as e:
        raise RuntimeError(f"ZIP ファイルが壊れています（再DL推奨）: {zip_path} — {e}")

    # 直接読み込み（GML/shapefile どちらも gpd.read_file が処理）
    try:
        return gpd.read_file(f"zip://{zip_path.resolve()}")
    except Exception as _e:
        print(f"  [warn] gpd.read_file 直接読み込み失敗、fallback へ: {_e}", flush=True)

    # フォールバック: GML/XML → shapefile の順で明示指定
    for ext in (".xml", ".gml", ".shp"):
        candidates = [n for n in names if n.endswith(ext)]
        if candidates:
            return gpd.read_file(f"zip://{zip_path.resolve()}!{candidates[0]}")

    raise RuntimeError(f"読み込み可能なファイルが見つかりません (GML/SHP): {zip_path}")

def find_jis_col(gdf) -> str:
    for c in ("N03_007", "N03_007_", "jiscode"):
        if c in gdf.columns:
            return c
    raise RuntimeError(f"JISコード列が見つかりません。列: {list(gdf.columns)}")

# ---------------------------------------------------------------------------
# Score formula
# ---------------------------------------------------------------------------

def score_candidate(max_depth_danger: int, flood_area_ratio: float) -> int:
    if max_depth_danger == 0:
        return 90
    depth_f  = max_depth_danger / 5.0
    area_f   = min(1.0, flood_area_ratio / 0.3)
    combined = depth_f * 0.5 + area_f * 0.5
    return max(10, min(90, round(90 - combined * 80)))

# ---------------------------------------------------------------------------
# Per-prefecture computation
# ---------------------------------------------------------------------------

def compute_pref(pref: str) -> list[dict]:
    import geopandas as gpd
    import pandas as pd

    a31 = load_gml(a31_zip(pref))
    n03 = load_gml(n03_zip(pref))

    jis_col = find_jis_col(n03)

    if "A31_001" not in a31.columns:
        raise RuntimeError(f"A31_001 列なし。列: {list(a31.columns)}")

    a31["depth_code"]   = pd.to_numeric(a31["A31_001"], errors="coerce").astype("Int64")
    # 1の位が深さ区分(1〜5)、10の位が洪水種別(1x=計画規模, 2x=想定最大規模 等)
    a31["depth_danger"] = a31["depth_code"].apply(
        lambda c: depth_danger_from_code(int(c)) if pd.notna(c) else 0
    ).astype(int)

    n03_clean = n03[n03[jis_col].notna() & (n03[jis_col] != "")].copy()
    name_df = (
        n03_clean.groupby(jis_col)[["N03_001", "N03_004"]]
        .first()
        .reset_index()
        .rename(columns={"N03_001": "prefecture", "N03_004": "name"})
    )

    a31_m    = a31.to_crs(METRIC_CRS)
    n03_m    = n03_clean[[jis_col, "geometry"]].to_crs(METRIC_CRS)
    n03_muni = n03_m.dissolve(by=jis_col).reset_index()
    n03_muni["muni_area_m2"] = n03_muni.geometry.area

    joined = gpd.overlay(
        a31_m[["depth_code", "depth_danger", "geometry"]],
        n03_muni[[jis_col, "muni_area_m2", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    joined["clip_area_m2"] = joined.geometry.area
    joined["dw_area"]      = joined["depth_danger"] * joined["clip_area_m2"]

    agg = joined.groupby(jis_col).agg(
        flood_area_m2   =("clip_area_m2", "sum"),
        flood_poly_count=("clip_area_m2", "count"),
        max_depth_code  =("depth_code",   "max"),
        max_depth_danger=("depth_danger", "max"),
        dw_area_sum     =("dw_area",      "sum"),
    ).reset_index()
    agg["mean_depth_score"] = (agg["dw_area_sum"] / agg["flood_area_m2"]).round(4)

    result = n03_muni[[jis_col, "muni_area_m2"]].merge(agg, on=jis_col, how="left")
    result = result.merge(name_df, on=jis_col, how="left")

    result["flood_area_m2"]    = result["flood_area_m2"].fillna(0.0)
    result["flood_poly_count"] = result["flood_poly_count"].fillna(0).astype(int)
    result["max_depth_code"]   = result["max_depth_code"].fillna(0).astype(int)
    result["max_depth_danger"] = result["max_depth_danger"].fillna(0).astype(int)
    result["mean_depth_score"] = result["mean_depth_score"].fillna(0.0)
    # 複数シナリオ重複で sum > muni_area_m2 になりうる → clamp
    result["flood_area_ratio"] = (
        result["flood_area_m2"] / result["muni_area_m2"]
    ).clip(upper=1.0).round(6)

    today = date.today().isoformat()
    rows: list[dict] = []
    for _, r in result.iterrows():
        has_flood = int(r["max_depth_code"]) > 0
        candidate = score_candidate(int(r["max_depth_danger"]), float(r["flood_area_ratio"]))
        rows.append({
            "jisCode":            str(r[jis_col]),
            "prefecture":         str(r.get("prefecture") or ""),
            "name":               str(r.get("name") or ""),
            "floodRiskCandidate": candidate,
            "maxDepthCode":       int(r["max_depth_code"]),
            "maxDepthDanger":     int(r["max_depth_danger"]),
            "meanDepthScore":     round(float(r["mean_depth_score"]), 4),
            "floodAreaRatio":     round(float(r["flood_area_ratio"]), 6),
            "floodPolyCount":     int(r["flood_poly_count"]),
            "floodDataStatus":    "scored" if has_flood else "no-flood-data",
            "floodSource":        FLOOD_SOURCE,
            "floodUpdatedAt":     today,
            "calculationVersion": CALC_VERSION,
        })
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

    status = r.get("floodDataStatus", "")
    if status not in VALID_STATUSES:
        errors.append(f"{tag} floodDataStatus 不正: {status!r}")

    cand = r.get("floodRiskCandidate")
    if status in ("scored", "no-flood-data"):
        if not (isinstance(cand, int) and 10 <= cand <= 90):
            errors.append(f"{tag} floodRiskCandidate: 10〜90整数必須: {cand!r}")
        if status == "no-flood-data" and cand != 90:
            errors.append(f"{tag} no-flood-data の候補値は 90 必須: {cand!r}")
    elif status in ("not-processed", "download-failed"):
        if cand is not None:
            errors.append(f"{tag} {status} の floodRiskCandidate は null 必須: {cand!r}")

    ratio = r.get("floodAreaRatio")
    if ratio is not None and not (0.0 <= ratio <= 1.0):
        errors.append(f"{tag} floodAreaRatio: 0〜1必須: {ratio!r}")

    mdc = r.get("maxDepthCode")
    if mdc is not None:
        valid_mdc = (mdc == 0) or (isinstance(mdc, int) and mdc >= 10 and depth_danger_from_code(mdc) > 0)
        if not valid_mdc:
            errors.append(f"{tag} maxDepthCode: 0 または X{{1〜5}}形式必須 (A31_001): {mdc!r}")

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

    # not-processed 補完
    today = date.today().isoformat()
    processed_jis = {r["jisCode"] for r in all_rows}
    for jis in sorted(muni_jis - processed_jis):
        m = muni_info[jis]
        all_rows.append({
            "jisCode":            jis,
            "prefecture":         m.get("prefecture", ""),
            "name":               m.get("municipality", ""),
            "floodRiskCandidate": None,
            "maxDepthCode":       None,
            "maxDepthDanger":     None,
            "meanDepthScore":     None,
            "floodAreaRatio":     None,
            "floodPolyCount":     None,
            "floodDataStatus":    "not-processed",
            "floodSource":        None,
            "floodUpdatedAt":     today,
            "calculationVersion": CALC_VERSION,
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
    scored_rows   = [r for r in all_rows if r["floodDataStatus"] == "scored"]
    no_flood_rows = [r for r in all_rows if r["floodDataStatus"] == "no-flood-data"]
    not_proc_rows = [r for r in all_rows if r["floodDataStatus"] == "not-processed"]
    candidates    = [r["floodRiskCandidate"] for r in scored_rows + no_flood_rows]
    ratios        = [r["floodAreaRatio"] for r in scored_rows]

    print(f"\n=== flood-v1 マージ統計 ===")
    print(f"  総出力件数         : {len(all_rows)}")
    print(f"  scored             : {len(scored_rows)}")
    print(f"  no-flood-data      : {len(no_flood_rows)}")
    print(f"  not-processed      : {len(not_proc_rows)}")
    print(f"  マージ済み都道府県 : {len(loaded_prefs)}/{len(ALL_PREFS)}")
    if candidates:
        print(f"\n  floodRiskCandidate : min={min(candidates)} / max={max(candidates)} "
              f"/ mean={sum(candidates)/len(candidates):.1f}")
    if ratios:
        print(f"  floodAreaRatio     : min={min(ratios):.4f} / max={max(ratios):.4f} "
              f"/ mean={sum(ratios)/len(ratios):.4f}")

    print(f"\n  最危険 上位10（floodRiskCandidate 昇順）:")
    for r in sorted(scored_rows, key=lambda x: x["floodRiskCandidate"])[:10]:
        print(f"    [{r['jisCode']}] {r['prefecture']} {r['name']}"
              f" | candidate={r['floodRiskCandidate']}"
              f" | maxDepth={r['maxDepthCode']} | area={r['floodAreaRatio']:.3f}")

    print(f"\n  最安全 上位10（scored のみ, 降順）:")
    for r in sorted(scored_rows, key=lambda x: x["floodRiskCandidate"], reverse=True)[:10]:
        print(f"    [{r['jisCode']}] {r['prefecture']} {r['name']}"
              f" | candidate={r['floodRiskCandidate']}"
              f" | maxDepth={r['maxDepthCode']} | area={r['floodAreaRatio']:.3f}")

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
            print(f"[{pref}] skip (既存 by-pref/{pref_json(pref).name}, {n}件)")
            pref_results.append((pref, "skipped", n))
            continue

        t0 = time.time()
        print(f"\n[{pref}] 処理開始…", flush=True)

        # ダウンロード
        dl_ok = True
        for layer, url_fn, zip_fn in [
            ("A31", a31_url, a31_zip),
            ("N03", n03_url, n03_zip),
        ]:
            url  = url_fn(pref)
            dest = zip_fn(pref)
            if do_dl:
                res = download_zip(url, dest)
                if res == "ok":
                    print(f"  [{layer}] DL完了: {dest.name}", flush=True)
                elif res == "skip":
                    print(f"  [{layer}] skip (既存): {dest.name}", flush=True)
                elif res == "not-found":
                    print(f"  [{layer}] not-found: {url}", flush=True)
                    dl_ok = False
                else:
                    print(f"  [{layer}] {res}: {url}", flush=True)
                    dl_ok = False
            else:
                if not dest.exists():
                    print(f"  [{layer}] 未取得 (--no-download): {dest.name}", flush=True)
                    dl_ok = False

        if not dl_ok or not a31_zip(pref).exists() or not n03_zip(pref).exists():
            print(f"  [{pref}] ZIP 不足 → download-failed")
            pref_results.append((pref, "dl-failed", 0))
            continue

        # 空間結合・スコア計算
        try:
            rows = compute_pref(pref)

            # per-pref バリデーション
            v_errors = validate_pref(pref, rows)
            if v_errors:
                print(f"  [{pref}] バリデーションエラー {len(v_errors)} 件:", file=sys.stderr)
                for e in v_errors[:5]:
                    print(f"    ❌ {e}", file=sys.stderr)
                pref_results.append((pref, "validate-failed", 0))
                continue

            # 即時保存
            save_pref_json(pref, rows)

            elapsed   = time.time() - t0
            scored_n  = sum(1 for r in rows if r["floodDataStatus"] == "scored")
            no_fld_n  = sum(1 for r in rows if r["floodDataStatus"] == "no-flood-data")
            print(f"  [{pref}] ✅ {len(rows)}自治体 "
                  f"(scored={scored_n}, no-flood={no_fld_n}) {elapsed:.0f}s → {pref_json(pref)}")
            pref_results.append((pref, "processed", len(rows)))

        except Exception as e:
            print(f"  [{pref}] ❌ エラー: {e}", file=sys.stderr)
            pref_results.append((pref, "error", 0))

    # ループ後サマリー
    print(f"\n--- 処理サマリー ---")
    for pref, status, cnt in pref_results:
        mark = "✅" if status in ("processed", "skipped") else "⚠️ " if status == "dl-failed" else "❌"
        print(f"  {mark} {pref}: {status:<16} {cnt:>4}自治体")

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="flood-v1 全国スコア算出")
    p.add_argument("--pref-start", metavar="CODE",
                   help="処理開始都道府県コード（例: 05）")
    p.add_argument("--pref-end",   metavar="CODE",
                   help="処理終了都道府県コード（例: 10）")
    p.add_argument("--pref-list",  nargs="+", metavar="CODE",
                   help="処理対象都道府県コードをスペース区切りで指定")
    p.add_argument("--skip-existing", action="store_true",
                   help="by-pref/ に既存 JSON がある県をスキップ（デフォルト OFF）")
    p.add_argument("--no-download", action="store_true",
                   help="自動 DL 無効（既存 ZIP のみ処理）")
    p.add_argument("--merge-only",  action="store_true",
                   help="DL・計算なし。by-pref/ を結合して flood-scores.json を生成")
    p.add_argument("--output", default="data/processed/flood-scores.json",
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

    # 処理完了後に by-pref/ を結合して --output に書き出す
    print(f"\n=== 処理完了 → マージ開始 ===")
    do_merge(out_path, muni_data)


if __name__ == "__main__":
    main()
