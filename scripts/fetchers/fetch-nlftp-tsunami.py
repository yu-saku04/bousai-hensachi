"""
fetch-nlftp-tsunami.py — Download A40 (津波浸水想定データ) GML from NLFTP

A40 カバレッジ状況（2024年7月時点）:
  NLFTP 提供: 28 都道府県（下記 A40_VERSIONS のキー）
  内陸7県 (INLAND_PREFS): 09=栃木 10=群馬 11=埼玉 19=山梨 20=長野 25=滋賀 29=奈良
    → 津波リスクなし（score=100） — fetch 不要
  その他未提供の沿岸県（岩手, 宮城, 福島, 東京, 富山, 福井, 愛知, 和歌山, 岡山, 香川, 熊本 等）
    → not-found 扱い（スコアリング時に missing）

各都道府県のバージョン（年度）は A40_VERSIONS で管理。
兵庫(28)は A40-16 (Seto/Pacific) と A40-18 (Sea of Japan) の2ファイルが存在するが、
fetch では A40-18 を優先（直近版）。A40-16 は追加シナリオとして別途処理可。

N03 行政区域は data/raw/flood/N03/ を流用するため本スクリプトでは取得しない。

Usage:
  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-tsunami.py [--pref CODE ...] [--download] [--dry-run]
  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-tsunami.py --all-prefs --download
"""

import argparse
import sys
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/A40"

# 都道府県ごとのデータバージョン（NLFTP 提供分のみ）
# 兵庫(28) は A40-16 + A40-18 の2ファイルが存在するが fetch 時は A40-18 を優先
A40_VERSIONS: dict[str, str] = {
    "01": "A40-17",  # 北海道
    "02": "A40-16",  # 青森
    "05": "A40-16",  # 秋田
    "06": "A40-16",  # 山形
    "08": "A40-16",  # 茨城
    "12": "A40-18",  # 千葉
    "14": "A40-16",  # 神奈川
    "17": "A40-17",  # 石川
    "21": "A40-17",  # 岐阜
    "22": "A40-16",  # 静岡
    "24": "A40-16",  # 三重
    "26": "A40-16",  # 京都
    "27": "A40-16",  # 大阪
    "28": "A40-18",  # 兵庫（A40-16 も存在するが A40-18 を優先）
    "31": "A40-18",  # 鳥取
    "32": "A40-17",  # 島根
    "34": "A40-16",  # 広島
    "35": "A40-16",  # 山口
    "36": "A40-16",  # 徳島
    "38": "A40-16",  # 愛媛
    "39": "A40-16",  # 高知
    "40": "A40-16",  # 福岡
    "41": "A40-16",  # 佐賀
    "42": "A40-16",  # 長崎
    "44": "A40-16",  # 大分
    "45": "A40-16",  # 宮崎
    "46": "A40-16",  # 鹿児島
    "47": "A40-16",  # 沖縄
}

# 完全内陸県（海岸線なし）→ fetch 不要、スコアリング時に no-tsunami-risk として処理
INLAND_PREFS = frozenset(["09", "10", "11", "19", "20", "25", "29"])

ALL_PREFS = [f"{i:02d}" for i in range(1, 48)]
OUT_DIR   = Path("data/raw/tsunami/A40")


def a40_url(pref: str) -> tuple[str, str]:
    """(url, version) を返す。pref が A40_VERSIONS に存在しない場合は ("", "") を返す。"""
    ver = A40_VERSIONS.get(pref)
    if not ver:
        return "", ""
    return f"{BASE_URL}/{ver}/{ver}_{pref}_GML.zip", ver


def probe(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status
    except HTTPError as e:
        return e.code
    except URLError:
        return 0


def download(url: str, dest: Path) -> str:
    """'ok' | 'skip' | 'not-found' | 'error-{detail}'"""
    if dest.exists():
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
        size_mb = dest.stat().st_size / 1024 / 1024
        print(f"  saved {dest} ({size_mb:.1f} MB)")
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch NLFTP A40 tsunami GML data")
    parser.add_argument("--pref", nargs="+", default=["08"],
                        metavar="CODE", help="2桁県コード（複数可）; default: 08")
    parser.add_argument("--all-prefs", action="store_true",
                        help="NLFTP 提供の28都道府県を対象")
    parser.add_argument("--download", action="store_true",
                        help="実際にダウンロード（省略時は probe のみ）")
    args = parser.parse_args()

    if args.all_prefs:
        prefs = sorted(A40_VERSIONS.keys())
    else:
        prefs = [p.zfill(2) for p in args.pref]

    do_download = args.download

    print(f"Mode   : {'DOWNLOAD' if do_download else 'PROBE'}")
    print(f"Prefs  : {prefs}")
    print(f"Output : {OUT_DIR}\n")

    results: dict[str, str] = {}

    for pref in prefs:
        if pref in INLAND_PREFS:
            print(f"  [skip] pref={pref}: 内陸県（津波リスクなし）— A40 fetch 不要")
            results[pref] = "inland"
            continue

        url, ver = a40_url(pref)
        if not url:
            print(f"  [skip] pref={pref}: NLFTP に A40 なし")
            results[pref] = "not-found"
            continue

        dest = OUT_DIR / f"{ver}_{pref}_GML.zip"

        if do_download:
            status = download(url, dest)
            if status == "ok":
                print(f"  [ok]   pref={pref} ({ver}): {dest.name}")
            elif status == "skip":
                print(f"  [skip] pref={pref} ({ver}): already exists")
            else:
                print(f"  [{status}] pref={pref} ({ver}): {url}")
            results[pref] = status
        else:
            code = probe(url)
            status = "ok" if code == 200 else f"HTTP {code}"
            print(f"  [{status}] pref={pref} ({ver}): {url}")
            results[pref] = status

    # サマリー
    ok_count      = sum(1 for s in results.values() if s in ("ok", "skip"))
    missing_count = sum(1 for s in results.values() if s == "not-found")
    inland_count  = sum(1 for s in results.values() if s == "inland")
    error_count   = len(results) - ok_count - missing_count - inland_count

    print(f"\n--- サマリー ---")
    print(f"  ok/skip   : {ok_count}")
    print(f"  inland    : {inland_count}  {sorted(p for p, s in results.items() if s == 'inland')}")
    print(f"  not-found : {missing_count}  {sorted(p for p, s in results.items() if s == 'not-found')}")
    print(f"  error     : {error_count}")

    if not do_download and prefs:
        print("\nRe-run with --download to fetch files.")

    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
