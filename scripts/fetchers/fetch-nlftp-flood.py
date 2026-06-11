"""
fetch-nlftp-flood.py — Download A31 (浸水想定区域) and N03 (行政区域) GML from NLFTP

Usage:
  python scripts/fetchers/fetch-nlftp-flood.py [--pref CODE [CODE ...]] [--download] [--dry-run]

  --pref CODE   2-digit prefecture code(s); default: 08 (Ibaraki)
  --download    actually download files (default: probe only)
  --dry-run     probe URLs without downloading (default)

Output: data/raw/flood/A31/ and data/raw/flood/N03/
"""

import argparse
import os
import sys
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data"

# A31 version as of 2026-06; URL-confirmed
A31_VERSION = "A31-12"
A31_YEAR    = "A31-12"

# N03 as of 2026-06; latest confirmed version
N03_DATE = "20240101"
N03_YEAR = "N03-2024"

ALL_PREFS = [f"{i:02d}" for i in range(1, 48)]  # 01–47


def a31_url(pref: str) -> str:
    return f"{BASE_URL}/A31/{A31_YEAR}/{A31_VERSION}_{pref}_GML.zip"


def n03_url(pref: str) -> str:
    return f"{BASE_URL}/N03/{N03_YEAR}/N03-{N03_DATE}_{pref}_GML.zip"


def probe(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status
    except HTTPError as e:
        return e.code
    except URLError:
        return 0


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        print(f"  [skip] {dest.name} already exists")
        return
    print(f"  downloading {url}")
    urllib.request.urlretrieve(url, dest)
    size_mb = dest.stat().st_size / 1024 / 1024
    print(f"  saved {dest} ({size_mb:.1f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch NLFTP flood/admin GML data")
    parser.add_argument("--pref", nargs="+", default=["08"],
                        metavar="CODE", help="2-digit prefecture code(s)")
    parser.add_argument("--all-prefs", action="store_true",
                        help="Download all 47 prefectures")
    parser.add_argument("--download", action="store_true",
                        help="Actually download (default: probe only)")
    args = parser.parse_args()

    prefs = ALL_PREFS if args.all_prefs else args.pref
    do_download = args.download

    out_a31 = Path("data/raw/flood/A31")
    out_n03 = Path("data/raw/flood/N03")

    print(f"Mode: {'DOWNLOAD' if do_download else 'PROBE'}")
    print(f"Prefs: {prefs}\n")

    for pref in prefs:
        urls = {
            "A31": (a31_url(pref), out_a31 / f"{A31_VERSION}_{pref}_GML.zip"),
            "N03": (n03_url(pref), out_n03 / f"N03-{N03_DATE}_{pref}_GML.zip"),
        }
        for layer, (url, dest) in urls.items():
            if do_download:
                download(url, dest)
            else:
                code = probe(url)
                status = "OK" if code == 200 else f"HTTP {code}"
                print(f"  [{status}] {layer} pref={pref}: {url}")

    if not do_download:
        print("\nRe-run with --download to fetch files.")


if __name__ == "__main__":
    main()
