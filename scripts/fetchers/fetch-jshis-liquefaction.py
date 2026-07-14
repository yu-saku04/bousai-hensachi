"""
fetch-jshis-liquefaction.py — J-SHIS 250mメッシュ微地形区分ZIPをダウンロードする

データソース:
  防災科学技術研究所（NIED）J-SHIS
  250mメッシュ微地形区分マップ 2020年版
  若松・松岡（2020）

出典表記（利用時は必ず明記）:
  「防災科学技術研究所（NIED）J-SHIS 250mメッシュ微地形区分データ（若松・松岡、2020）」
  https://www.j-shis.bosai.go.jp/labs/wm2020/

利用条件:
  - 加工後の成果物（スコアJSON等）の公開は可
  - 原データの複製・再配布は禁止
  - 出典明記が必要
  → raw ZIP / CSV は Git 管理対象外（.gitignore で除外）

Usage:
  python3 scripts/fetchers/fetch-jshis-liquefaction.py
  python3 scripts/fetchers/fetch-jshis-liquefaction.py --force
  python3 scripts/fetchers/fetch-jshis-liquefaction.py --dry-run
  python3 scripts/fetchers/fetch-jshis-liquefaction.py --output-dir data/raw/liquefaction
  python3 scripts/fetchers/fetch-jshis-liquefaction.py --url https://...
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError

DEFAULT_URL     = "https://www.j-shis.bosai.go.jp/labs/wm2020/data/Z-WM2020-JAPAN-M250.zip"
DEFAULT_OUT_DIR = Path("data/raw/liquefaction")
ZIP_FILENAME    = "Z-WM2020-JAPAN-M250.zip"
USER_AGENT      = "bousai-hensachi/1.0 (+https://github.com/yu-saku04/bousai-hensachi)"
TIMEOUT         = 300   # seconds
MAX_RETRIES     = 3

LICENSE_NOTE = """
=============================================================
  J-SHIS 250mメッシュ微地形区分データ 利用条件
=============================================================
  提供: 防災科学技術研究所（NIED）
  データ: 若松・松岡（2020）微地形区分マップ 2020年版
  URL  : https://www.j-shis.bosai.go.jp/labs/wm2020/

  ✔  加工成果物（スコアJSON等）の公開: 許可
  ✔  出典明記: 必須
      「防災科学技術研究所（NIED）J-SHIS 250mメッシュ微地形区分データ（若松・松岡、2020）」
  ✘  原データ（CSV/ZIP）の複製・再配布: 禁止
  → raw ファイルは .gitignore で Git 管理対象外としてください
=============================================================
"""


def probe_url(url: str) -> tuple[int, int]:
    """HEADリクエストでHTTPステータスとContent-Lengthを返す。"""
    req = urllib.request.Request(
        url, method="HEAD", headers={"User-Agent": USER_AGENT}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            size = int(r.headers.get("Content-Length", 0))
            return r.status, size
    except HTTPError as e:
        return e.code, 0
    except URLError as e:
        print(f"  URL エラー: {e.reason}", file=sys.stderr)
        return 0, 0


def download_with_retry(url: str, dest: Path, max_retries: int = MAX_RETRIES) -> None:
    """リトライ付きダウンロード。"""
    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            print(f"  Downloading (試行 {attempt}/{max_retries}): {url}", flush=True)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r, \
                 open(dest, "wb") as f:
                status = r.status
                total  = int(r.headers.get("Content-Length", 0))
                print(f"  HTTP {status}  Content-Length: {total/1024/1024:.1f} MB", flush=True)
                downloaded = 0
                block = 65536
                while True:
                    chunk = r.read(block)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = downloaded / total * 100
                        print(f"  ... {downloaded/1024/1024:.1f} MB / {total/1024/1024:.1f} MB ({pct:.0f}%)",
                              end="\r", flush=True)
            print(f"\n  saved {dest.name} ({dest.stat().st_size / 1024 / 1024:.1f} MB)")
            return
        except (HTTPError, URLError, OSError) as e:
            print(f"\n  [warn] ダウンロード失敗 (試行 {attempt}): {e}", file=sys.stderr)
            if dest.exists():
                dest.unlink()
            if attempt < max_retries:
                wait = 2 ** attempt
                print(f"  {wait}秒後にリトライ...", file=sys.stderr)
                time.sleep(wait)
            else:
                raise RuntimeError(f"ダウンロード失敗（{max_retries}回）: {e}") from e


def check_zip_integrity(zip_path: Path) -> list[str]:
    """ZIPの整合性チェックと内部ファイル一覧を返す。"""
    try:
        with zipfile.ZipFile(zip_path) as z:
            bad = z.testzip()
            if bad:
                raise RuntimeError(f"ZIP 破損ファイル: {bad}")
            return z.namelist()
    except zipfile.BadZipFile as e:
        raise RuntimeError(f"ZIP 破損: {e}") from e


def main() -> None:
    parser = argparse.ArgumentParser(
        description="J-SHIS 250mメッシュ微地形区分ZIPをダウンロードする"
    )
    parser.add_argument("--url", default=DEFAULT_URL,
                        help=f"ダウンロードURL (デフォルト: {DEFAULT_URL})")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT_DIR,
                        help=f"保存先ディレクトリ (デフォルト: {DEFAULT_OUT_DIR})")
    parser.add_argument("--force", action="store_true",
                        help="既存ファイルがあっても再ダウンロード")
    parser.add_argument("--dry-run", action="store_true",
                        help="URLをprobeするのみ（実際のダウンロードはしない）")
    args = parser.parse_args()

    print(LICENSE_NOTE)

    url     = args.url
    out_dir = args.output_dir
    zip_path = out_dir / ZIP_FILENAME

    print(f"URL       : {url}")
    print(f"保存先    : {zip_path}")
    print(f"force     : {args.force}")
    print(f"dry-run   : {args.dry_run}")

    # --- URL probe ---
    print(f"\n[1/3] URL probe ...", flush=True)
    status, size = probe_url(url)
    if status == 200:
        print(f"  [✅ ok] HTTP {status}, Content-Length: {size/1024/1024:.1f} MB")
    else:
        print(f"  [❌ fail] HTTP {status}", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("\n(dry-run) 実際にダウンロードするには --dry-run を外してください。")
        return

    # --- Download ---
    print(f"\n[2/3] ダウンロード ...", flush=True)
    if zip_path.exists() and not args.force:
        mb = zip_path.stat().st_size / 1024 / 1024
        print(f"  [skip] 既存ファイルあり: {zip_path.name} ({mb:.1f} MB)")
        print(f"  再取得するには --force を指定してください。")
    else:
        out_dir.mkdir(parents=True, exist_ok=True)
        download_with_retry(url, zip_path)

    # --- ZIP integrity check ---
    print(f"\n[3/3] ZIP整合性チェック ...", flush=True)
    try:
        names = check_zip_integrity(zip_path)
    except RuntimeError as e:
        print(f"  [❌] {e}", file=sys.stderr)
        sys.exit(1)

    print(f"  [✅] ZIPファイル正常 ({len(names)}ファイル)")
    print("  内部ファイル一覧:")
    for name in names:
        print(f"    {name}")

    # CSV存在確認
    csvs = [n for n in names if n.lower().endswith(".csv")]
    if csvs:
        print(f"\n  CSVファイル確認: {csvs}")
    else:
        print(f"\n  [warn] ZIP内にCSVファイルが見つかりません: {names}", file=sys.stderr)

    print(f"\n✅ 完了: {zip_path}")
    print("  次のステップ: python3 scripts/scoring/score-liquefaction-v1.py --inspect-csv")


if __name__ == "__main__":
    main()
