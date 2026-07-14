"""
fetch-nlftp-storm-surge.py — Download A49 (高潮浸水想定区域) GML from NLFTP

A49 カバレッジ状況（2025年時点）:
  NLFTP 提供: 15 都道府県（下記 A49_VERSIONS のキー）
  内陸8県 (INLAND_PREFS): 09=栃木 10=群馬 11=埼玉 19=山梨 20=長野 21=岐阜 25=滋賀 29=奈良
    → 高潮リスクなし（score=100） — fetch 不要
  その他未提供の沿岸県（北海道, 岩手, 宮城, 茨城, 新潟, 石川, 静岡, 広島, 愛媛, 高知, 長崎,
                         熊本, 鹿児島, 沖縄 等）
    → not-found 扱い（スコアリング時に missing）

URL 形式: https://nlftp.mlit.go.jp/ksj/gml/data/A49/{ver}/{ver}_{pref}_GML.zip
例:       https://nlftp.mlit.go.jp/ksj/gml/data/A49/A49-24/A49-24_14_GML.zip

各都道府県のバージョン（年度）は A49_VERSIONS で管理。

N03 行政区域は data/raw/flood/N03/ を流用するため本スクリプトでは取得しない。

Usage:
  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-storm-surge.py --pref 14
  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-storm-surge.py --all
  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-storm-surge.py --pref 14 --dry-run
  .venv-flood/bin/python scripts/fetchers/fetch-nlftp-storm-surge.py --pref 14 --force
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError

USER_AGENT      = "bousai-hensachi/1.0 (+https://github.com/haradayusaku/bousai-hensachi)"
BASE_URL        = "https://nlftp.mlit.go.jp/ksj/gml/data/A49"
DEFAULT_OUT_DIR = Path("data/raw/storm-surge/A49")

# 都道府県ごとの A49 バージョン（年度2桁形式、NLFTP 提供15都道府県）
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

# 完全内陸県（海岸線なし）→ fetch 不要、スコアリング時に no-storm-surge-risk として処理
# 注: A40（津波）と異なり岐阜(21)も内陸扱い（伊勢湾への直接沿岸なし）
INLAND_PREFS = frozenset(["09", "10", "11", "19", "20", "21", "25", "29"])

ALL_PREFS = [f"{i:02d}" for i in range(1, 48)]


def a49_url(pref: str) -> tuple[str, str]:
    """(url, version) を返す。pref が A49_VERSIONS に存在しない場合は ("", "") を返す。"""
    ver = A49_VERSIONS.get(pref)
    if not ver:
        return "", ""
    return f"{BASE_URL}/{ver}/{ver}_{pref}_GML.zip", ver


def _make_request(url: str, method: str = "GET") -> urllib.request.Request:
    req = urllib.request.Request(url, method=method)
    req.add_header("User-Agent", USER_AGENT)
    return req


def probe(url: str, timeout: int = 15) -> int:
    try:
        with urllib.request.urlopen(_make_request(url, "HEAD"), timeout=timeout) as resp:
            return resp.status
    except HTTPError as e:
        return e.code
    except URLError:
        return 0


def download_with_retry(
    url: str,
    dest: Path,
    retries: int = 3,
    timeout: int = 120,
) -> str:
    """'ok' | 'skip' | 'not-found' | 'error-...' を返す。"""
    if dest.exists():
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")

    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(_make_request(url), timeout=timeout) as resp, \
                    open(tmp, "wb") as fh:
                fh.write(resp.read())

            # ZIP 破損チェック
            try:
                with zipfile.ZipFile(tmp) as z:
                    bad = z.testzip()
                    if bad:
                        raise zipfile.BadZipFile(f"破損エントリ: {bad}")
            except zipfile.BadZipFile as e:
                tmp.unlink(missing_ok=True)
                if attempt < retries:
                    print(f"  [warn] ZIP破損 attempt={attempt}: {e} — {2**attempt}s 後リトライ",
                          flush=True)
                    time.sleep(2 ** attempt)
                    continue
                return f"error-bad-zip"

            tmp.rename(dest)
            size_mb = dest.stat().st_size / 1024 / 1024
            print(f"  saved {dest.name} ({size_mb:.1f} MB)", flush=True)
            return "ok"

        except HTTPError as e:
            tmp.unlink(missing_ok=True)
            if e.code == 404:
                return "not-found"
            if attempt < retries:
                print(f"  [warn] HTTP {e.code} attempt={attempt} — {2**attempt}s 後リトライ",
                      flush=True)
                time.sleep(2 ** attempt)
                continue
            return f"error-http-{e.code}"

        except URLError as e:
            tmp.unlink(missing_ok=True)
            if attempt < retries:
                print(f"  [warn] URLError attempt={attempt}: {e.reason} — {2**attempt}s 後リトライ",
                      flush=True)
                time.sleep(2 ** attempt)
                continue
            return f"error-url"

        except Exception as e:
            tmp.unlink(missing_ok=True)
            return f"error-{type(e).__name__}"

    return "error-max-retries"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch NLFTP A49 storm surge (高潮浸水想定区域) GML data"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pref",  nargs="+", metavar="CODE",
                       help="2桁県コード（複数可）")
    group.add_argument("--all",   action="store_true",
                       help="A49 提供 15 都道府県を全て対象")
    parser.add_argument("--force",      action="store_true",
                        help="既存ファイルがあっても再ダウンロード")
    parser.add_argument("--dry-run",    action="store_true",
                        help="probe のみ（実際にはダウンロードしない）")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT_DIR,
                        metavar="DIR",
                        help=f"出力先ディレクトリ（default: {DEFAULT_OUT_DIR}）")
    args = parser.parse_args()

    out_dir: Path = args.output_dir

    if args.all:
        prefs = sorted(A49_VERSIONS.keys())
    else:
        prefs = [p.zfill(2) for p in args.pref]

    mode = "DRY-RUN (probe only)" if args.dry_run else "DOWNLOAD"
    print(f"Mode      : {mode}")
    print(f"Prefs     : {prefs}")
    print(f"Output dir: {out_dir}\n")

    results: dict[str, str] = {}

    for pref in prefs:
        if pref in INLAND_PREFS:
            print(f"  [skip]     pref={pref}: 内陸県 — 高潮リスクなし、A49 fetch 不要")
            results[pref] = "inland"
            continue

        url, ver = a49_url(pref)
        if not url:
            print(f"  [not-found] pref={pref}: NLFTP に A49 未収録")
            results[pref] = "not-found"
            continue

        dest = out_dir / f"{ver}_{pref}_GML.zip"

        if args.dry_run:
            code   = probe(url)
            status = "ok" if code == 200 else f"HTTP {code}"
            icon   = "✅" if code == 200 else ("❌" if code == 404 else "⚠️ ")
            print(f"  [{icon} {status:10s}] pref={pref} ({ver}): {url}")
            results[pref] = status
            continue

        if dest.exists() and not args.force:
            size_mb = dest.stat().st_size / 1024 / 1024
            print(f"  [skip]     pref={pref} ({ver}): already exists ({size_mb:.1f} MB)")
            results[pref] = "skip"
            continue

        if args.force and dest.exists():
            print(f"  [force]    pref={pref} ({ver}): 既存ファイル削除して再DL")
            dest.unlink()

        print(f"  Downloading pref={pref} ({ver}): {url}", flush=True)
        status = download_with_retry(url, dest)

        if status == "ok":
            print(f"  [ok]       pref={pref} ({ver}): {dest.name}")
        elif status == "not-found":
            print(f"  [not-found] pref={pref} ({ver}): HTTP 404 — {url}")
            print(f"             バージョン辞書 A49_VERSIONS を確認してください。")
        else:
            print(f"  [{status}] pref={pref} ({ver}): {url}")
        results[pref] = status

    print(f"\n--- サマリー ---")
    ok_cnt     = sum(1 for s in results.values() if s in ("ok", "skip"))
    nf_cnt     = sum(1 for s in results.values() if s == "not-found")
    inland_cnt = sum(1 for s in results.values() if s == "inland")
    err_cnt    = len(results) - ok_cnt - nf_cnt - inland_cnt

    print(f"  ok/skip   : {ok_cnt}")
    print(f"  inland    : {inland_cnt}  {sorted(p for p, s in results.items() if s == 'inland')}")
    print(f"  not-found : {nf_cnt}  {sorted(p for p, s in results.items() if s == 'not-found')}")
    print(f"  error     : {err_cnt}")

    if args.dry_run:
        print("\n(dry-run) 実際にダウンロードするには --dry-run を外して再実行してください。")
    if err_cnt > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
