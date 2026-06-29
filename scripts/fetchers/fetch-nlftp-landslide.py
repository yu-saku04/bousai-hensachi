"""
fetch-nlftp-landslide.py — Download A33 (土砂災害警戒区域等) GML from NLFTP

A33 バージョン状況（2026-06 確認済み）:
  A33-15 : 45/47 都道府県（23=愛知・40=福岡 を除く）
  A33-13 : 40=福岡 フォールバック
  23=愛知: 全バージョンで NLFTP に不在 → not-found として扱う

N03 行政区域は data/raw/flood/N03/ を流用するため本スクリプトでは取得しない。

Usage:
  python scripts/fetchers/fetch-nlftp-landslide.py [--pref CODE [CODE ...]] [--download] [--dry-run]

  --pref CODE     2桁県コード（複数可）; default: 08 (茨城)
  --all-prefs     全47都道府県を対象
  --download      実際にダウンロード（省略時は probe のみ）

Output: data/raw/landslide/A33/
"""

import argparse
import sys
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/A33"

PRIMARY_VERSION  = "A33-15"
FALLBACK_VERSION = {
    "40": "A33-13",   # 福岡: A33-15 不在 → A33-13 で確認済み
}
KNOWN_MISSING = {
    "23",             # 愛知: NLFTP 全バージョンで不在
}

ALL_PREFS = [f"{i:02d}" for i in range(1, 48)]

OUT_DIR = Path("data/raw/landslide/A33")


def a33_url(pref: str) -> tuple[str, str]:
    """(url, version) を返す。"""
    ver = FALLBACK_VERSION.get(pref, PRIMARY_VERSION)
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
    """'ok' | 'skip' | 'not-found' | 'error-{detail}' を返す。

    一時ファイル (.tmp) にダウンロードし、成功後に dest へリネーム。
    中断・失敗時は .tmp を削除するため破損ファイルが残らない。
    """
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
    parser = argparse.ArgumentParser(description="Fetch NLFTP A33 landslide GML data")
    parser.add_argument("--pref", nargs="+", default=["08"],
                        metavar="CODE", help="2桁県コード（複数可）; default: 08")
    parser.add_argument("--all-prefs", action="store_true",
                        help="全47都道府県を対象")
    parser.add_argument("--download", action="store_true",
                        help="実際にダウンロード（省略時は probe のみ）")
    args = parser.parse_args()

    prefs       = ALL_PREFS if args.all_prefs else args.pref
    do_download = args.download

    print(f"Mode   : {'DOWNLOAD' if do_download else 'PROBE'}")
    print(f"Prefs  : {prefs}")
    print(f"Output : {OUT_DIR}\n")

    results: dict[str, str] = {}  # pref -> status

    for pref in prefs:
        if pref in KNOWN_MISSING:
            print(f"  [skip] pref={pref}: NLFTP に A33 なし（愛知は全バージョン不在）")
            results[pref] = "not-found"
            continue

        url, ver = a33_url(pref)
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
    error_count   = len(results) - ok_count - missing_count

    print(f"\n--- サマリー ---")
    print(f"  ok/skip   : {ok_count}")
    print(f"  not-found : {missing_count}  {sorted(p for p, s in results.items() if s == 'not-found')}")
    print(f"  error     : {error_count}")

    if not do_download:
        print("\nRe-run with --download to fetch files.")

    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
