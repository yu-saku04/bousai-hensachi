# data/raw/national/ — 全国避難所CSV 配置ガイド

## 概要

このディレクトリに全国避難所CSVを配置し、`npm run data:build:national` を実行することで
`src/data/municipalities.json` / `src/data/municipality-search-index.json` が更新されます。

---

## 配置ファイル

| ファイル | 内容 |
|---|---|
| `municipalities.csv` | 全国市区町村マスター（必須） |
| `shelters.csv` | 全国避難所データ（必須） |
| `population.csv` | 市区町村別人口データ（任意・投入予定） |

---

## 取得元候補

### 第一候補: 国土地理院 指定緊急避難場所・指定避難所データ

- 公式ページ: https://www.gsi.go.jp/bousaichiri/hinanbasho.html
- ダウンロード一覧: https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html
- 提供形式: CSV / GeoJSON
- 備考: 国土地理院・内閣府・消防庁が、指定緊急避難場所および指定避難所をCSV/GeoJSONで提供しています。閲覧・提供データは市町村が登録し公開同意したものに限られるため、最新・完全な指定状況は各市町村の情報確認が必要です。

GSIダウンロード一覧では、全国分・都道府県別・市町村別のCSVが提供されています。全国CSVの主な列は以下です。

### shelter-v1 の投入対象

現行の `shelter-v1` は、主対象を **指定避難所CSV** として扱います。`shelterCapacity` は「避難所の余裕度」全体ではなく、主に **人口1万人あたり指定避難所数** を優先して算出します。`capacity` は現時点では補助データとして保持し、将来の重みづけ候補です。

指定緊急避難場所CSVは、洪水・地震・津波などの災害種別を取得できる一方で、「災害時に一定期間滞在する指定避難所の数」とは意味が異なります。そのため、現行では補完データ、または将来の `shelter-v2` / 別指標の候補として扱います。

指定緊急避難場所:

```text
NO, 共通ID, 都道府県名及び市町村名, 施設・場所名, 住所,
洪水, 崖崩れ、土石流及び地滑り, 高潮, 地震, 津波,
大規模な火事, 内水氾濫, 火山現象,
指定避難所との住所同一, 緯度, 経度, 備考
```

指定避難所:

```text
NO, 共通ID, 都道府県名及び市町村名, 施設・場所名, 住所,
指定緊急避難場所との住所同一,
その他市町村長が必要と認める事項, 受入対象者,
緯度, 経度, 備考
```

### 補完候補: 自治体オープンデータ

GSIデータに収容人数がない、または自治体独自項目を補いたい場合は、各自治体のオープンデータカタログを利用します。自治体データは列名・文字コード・緯度経度形式が統一されていないため、自治体別converterまたは手動整形が必要です。

### 補完候補: 政府・自治体横断カタログ

デジタル庁/自治体標準オープンデータ、都道府県オープンデータカタログ、各市区町村の防災ページを補完候補にします。ただし、JISコード・施設名・住所・緯度経度・更新日・出典URLを標準CSVへ揃える必要があります。

---

## GSI CSV 変換手順

GSIのCSVには市区町村JISコードが直接含まれないため、`data/master/municipalities-base.json` の `prefecture + municipality` から `jisCode` を補完します。先に `municipalities.csv` から全国masterを生成しておいてください。

```bash
# 1. GSIから全国または都道府県別CSVを取得して配置
#    shelter-v1 の主対象は指定避難所CSVです。
#    指定緊急避難場所CSVは補完データまたは将来 shelter-v2 候補です。
#    例: data/raw/gsi/shelters.csv

# 2. 必要なら全国masterを先に生成
npm run master:generate

# 3. GSI CSVを標準 shelters.csv へ変換
npm run convert:gsi-shelters -- \
  --input data/raw/gsi/shelters.csv \
  --output data/raw/national/shelters.csv \
  --master data/master/municipalities-base.json \
  --source-url https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html \
  --updated-at 2026-05-25

# 4. 標準CSVを投入
npm run data:build:national
```

`--updated-at` は取得日またはGSIダウンロード一覧の最終更新日を指定してください。未指定時は実行日の日本日付を使います。

### GSI列から標準列への変換

| 標準列 | 変換元 |
|---|---|
| `jisCode` | `municipalities-base.json` の prefecture + municipality 照合 |
| `prefecture` | master照合結果 |
| `municipality` | master照合結果 |
| `shelterName` | `施設・場所名` |
| `address` | `住所` |
| `latitude` | `緯度` |
| `longitude` | `経度` |
| `capacity` | `収容人数` / `収容可能人数` がある場合のみ。GSI標準CSVでは通常空 |
| `disasterTypes` | 指定緊急避難場所の災害種別列から `flood\|landslide\|storm\|earthquake\|tsunami\|fire\|inland_flood\|volcano` へ変換。指定避難所CSVでは `unknown` |
| `sourceUrl` | converter の `--source-url` |
| `updatedAt` | converter の `--updated-at` |

GSIの指定避難所CSVには災害種別列や収容人数がないため、`disasterTypes=unknown`、`capacity` は空欄になります。後続の `import:shelters:national` では空欄capacityを0として集計しwarning扱いにします。指定緊急避難場所CSVは災害種別を取得できますが、避難所数スコアとは意味が異なるため、現行では補完データまたは将来の別指標候補です。

---

## population.csv — e-Stat 国勢調査2020 投入ガイド

### 概要・取得元

`population.csv` の本命データソースは **e-Stat 令和2年国勢調査 人口等基本集計 表1-1-1** です。

| 項目 | 内容 |
|---|---|
| 統計表ID (statdisp_id) | `0003445078` |
| 統計名 | 令和２年国勢調査 人口等基本集計 |
| 表名 | 表1-1-1 男女別人口－全国，都道府県，市区町村 |
| 公表日 | 2021-11-30 |
| 取得先 URL | https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445078 |
| 利用規約 | 統計法第32条に基づく二次利用可（CC BY 4.0相当） |

### e-Stat API キーの準備

`statdisp_id=0003445078` はデータベース形式のデータセットです。CSV取得には e-Stat APIアプリケーションIDが必要です。

1. `https://www.e-stat.go.jp/mypage/user/preregister` でアカウント登録（無料）
2. マイページ → 「アプリケーションIDの発行」
3. プロジェクトルートに `.env.local` を作成：

```
ESTAT_APP_ID=your_app_id_here
```

`.env.local` は `.gitignore` で除外済みです。**絶対にGitにコミットしないでください。**

### 取得・変換手順

```bash
# 1. e-Stat API で CSV を自動取得（ESTAT_APP_ID 要設定）
npm run fetch:estat-population-2020
#    → data/raw/estat/population-2020.csv が保存される

# 2. 標準 population.csv に変換
npm run convert:estat-population-2020 -- --allow-missing
#    → data/raw/national/population.csv が生成される（1,908件）
#    → --allow-missing: 既知の欠損10件（北方領土6村・双葉町・浜松市新3区）を許容して続行
#    → 列: jisCode,prefecture,municipality,population,sourceUrl,updatedAt
#    → sourceUrl: https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445078
#    → updatedAt: 2021-11-30

# 3. インポート
npm run import:population
#    → data/processed/population.json が生成される

# 4. マージ（municipalities.json に population / populationSource / populationUpdatedAt を反映）
npm run merge:data:strict

# 5. strict バリデーション（1,908件以上を確認）
#    ※ 既知欠損10件（北方領土6村・双葉町・浜松市新3区）は許容済み
npm run validate:data -- --strict

# 6. lint / tsc / ビルド確認
npm run lint
npx tsc --noEmit
npm run build
```

#### ESTAT_APP_ID 未設定時

```
ERROR: ESTAT_APP_ID が設定されていません。
【設定手順】
  1. https://www.e-stat.go.jp/mypage/user/preregister でアカウント登録（無料）
  2. マイページ → アプリケーションID を発行
  3. プロジェクトルートに .env.local を作成し、以下を記載:
       ESTAT_APP_ID=your_app_id_here
  4. 再度このコマンドを実行: npm run fetch:estat-population-2020
```

### converter 仕様（convert-estat-population-2020.ts）

| 項目 | 内容 |
|---|---|
| 入力 | `data/raw/estat/population-2020.csv` |
| 出力 | `data/raw/national/population.csv` |
| master参照 | `data/master/municipalities-base.json` |
| フォーマット対応 | 長形式（男女列・表章事項列あり）・幅形式（総数列直接）の両方 |
| 男女フィルタ | 男女=総数 のみ採用 |
| 表章事項フィルタ | 表章事項=人口 のみ採用 |
| 除外対象 | 全国行・都道府県行・旧市町村・人口集中地区（master照合で自動除外） |
| jisCode重複 | error |
| coverage | 1,908件以上で正常（既知欠損10件を許容）。`--allow-missing` フラグ必須 |
| 出力順 | master順（jisCode昇順）で安定 |
| prefecture/municipality | CSV側の表記ゆれを吸収するため master の値を使用 |

### e-Stat CSV 文字コードについて

e-Stat の 2020年国勢調査 CSV は **UTF-8**（BOM付き可）で提供されます。
Shift-JIS / CP932 形式のファイルは converter が正常に読み込めません。
ダウンロード時に UTF-8 で保存してください。

### converter 列名対応表

CSVの列名が揺れる場合も、以下の候補を自動検出します。

| 列の役割 | 対応する列名候補 |
|---|---|
| 地域コード | `地域コード`, `area_code`, `AREA_CODE`, `コード`, `市区町村コード` |
| 男女別 | `男女`, `男女別`, `cat01`, `CAT01`, `sex`, `性別` |
| 表章事項 | `表章事項`, `cat02`, `CAT02`, `表章`, `item`, `項目` |
| 人口値 | `人口（人）`, `人口(人)`, `人口`, `VALUE`, `総数`, `人口総数` |

### e-Stat CSV の注意事項

- メタデータ行（先頭の統計名・表名等）は自動スキップされます
- カンマ区切りの数値（例: `1,973,395`）は自動正規化されます
- `地域コード` のゼロ埋め（例: `1100` → `01100`）は自動補正されます
- 政令指定都市は市レベル（例: `01100` 札幌市）と区レベル（例: `01101` 中央区）の両方が master にあるため、e-Stat CSV が両方を提供していれば両方が出力されます
- **文字化けした場合は UTF-8 で再保存してください。** ダウンロード直後に Shift-JIS / CP932 でブラウザが保存している場合があります。テキストエディタで開き「UTF-8 (BOM なし)」で保存し直してから converter を実行してください
- **population 値はカンマ除去後に正の整数のみ許可されます。** 小数（`1.5`）・単位付き文字列（`1000人`）・注記付き文字列（`*123`）・`0` は変換対象外としてスキップされます。これらを `parseInt` で切り捨てる silent truncate は行いません

---

## population.csv 仕様（投入予定）

### 概要

市区町村別の総人口を格納するCSVです。
避難所充足率（`sheltersPerTenThousand`・`capacityPerPopulation`）、高齢化率、孤立リスクの基礎データとして使います。

**現在: ヘッダーのみ。実データは取得後に追記してください。**

### 取得元候補

| 優先度 | 取得元 | URL | 形式 | 備考 |
|---|---|---|---|---|
| ★★★ | e-Stat 国勢調査2020年（市区町村別人口） | https://www.e-stat.go.jp/ | CSV | 「人口等基本集計」→「市区町村」→CSV一括DL |
| ★★☆ | 住民基本台帳人口・世帯数調査（毎年3月末） | https://www.soumu.go.jp/main_sosiki/jichi_gyousei/daityo/jinkou_jichi.html | Excel | 年次更新あり。最新人口動態を反映 |
| ★☆☆ | 総務省統計局 統計データ検索 | https://www.stat.go.jp/data/ | CSV | 国勢調査と住民基本台帳の補完 |

### カラム仕様

| カラム | 型 | 必須 | 説明 | 例 |
|---|---|---|---|---|
| `jisCode` | string | ✅ | 市区町村JISコード（5桁数字） | `13112` |
| `prefecture` | string | ✅ | 都道府県名（全角） | `東京都` |
| `municipality` | string | ✅ | 市区町村名（全角） | `世田谷区` |
| `population` | integer | ✅ | 総人口（正の整数） | `915992` |
| `sourceUrl` | string | ✅ | 出典URL（`http(s)://` 必須） | `https://www.e-stat.go.jp/...` |
| `updatedAt` | string | ✅ | データ更新日（`YYYY-MM-DD` 形式） | `2021-11-30` |

### 投入手順

```bash
# 1. population.csv に実データを追記
#    data/raw/national/population.csv

# 2. インポーター実行
npm run import:population
# → data/processed/population.json が生成される

# 3. マージ・バリデーション
npm run merge:data:strict
npm run validate:data -- --strict

# 4. ビルド確認
npm run build
```

### 注意事項

- `jisCode` は `data/master/municipalities-base.json` に存在する5桁コードのみ有効
- `population` は正の整数（小数・0・負数はエラー）
- `sourceUrl` は `http://` または `https://` から始まるURLが必須
- `updatedAt` は `YYYY-MM-DD` 形式（例: `2021-11-30`）

---

## municipalities.csv 仕様

### 必須カラム

| カラム | 説明 | 例 |
|---|---|---|
| `jisCode` | 市区町村JISコード（5桁数字） | `13112` |
| `prefecture` | 都道府県名（全角） | `東京都` |
| `municipality` | 市区町村名（全角） | `世田谷区` |

### 推奨カラム

| カラム | 説明 | 例 |
|---|---|---|
| `population` | 人口（正の整数） | `930000` |
| `agingRate` | 高齢化率（0〜100 の数値、%） | `21.8` |
| `latitude` | 緯度（20〜46） | `35.6464` |
| `longitude` | 経度（122〜154） | `139.6530` |
| `id` | 一意ID（省略時は `muni-{jisCode}`） | `tokyo-setagaya` |

---

## shelters.csv 仕様

### 必須カラム

| カラム | 説明 | 例 |
|---|---|---|
| `jisCode` | 市区町村JISコード（5桁数字） | `13112` |
| `prefecture` | 都道府県名 | `東京都` |
| `municipality` | 市区町村名 | `世田谷区` |
| `shelterName` | 施設名 | `世田谷小学校` |
| `sourceUrl` | 出典URL（`http(s)://` 必須） | `https://...` |
| `updatedAt` | データ更新日（`YYYY-MM-DD` 形式） | `2026-05-22` |

### 推奨カラム

| カラム | 説明 | 例 | 欠損時の扱い |
|---|---|---|---|
| `capacity` | 収容人数（正の整数） | `350` | 0として集計（warning） |
| `disasterTypes` | 対応災害種別（パイプ区切り） | `earthquake\|flood` | `unknown`として扱う |
| `address` | 住所 | `東京都世田谷区...` | スキップ |
| `latitude` | 緯度（20〜46） | `35.6464` | スキップ |
| `longitude` | 経度（122〜154） | `139.6530` | スキップ |

### disasterTypes に使用できる値

`earthquake`, `flood`, `fire`, `tsunami`, `volcano`, `landslide`, `storm`, `inland_flood`, `unknown`

### shelterCapacity の現行算出方針

現行の `shelter-v1` における `shelterCapacity` は、「避難所の余裕度」全体ではなく、主に「人口1万人あたり指定避難所数」を優先して算出しています。収容人数 `capacity` は現時点では補助データとして保持し、`capacityPerPopulation` として将来の `shelter-v2` 以降で重みづけに使う可能性があります。

---

## 文字コード・フォーマット

- 文字コード: **UTF-8**（BOM付きも可）
- 改行コード: LF または CRLF
- 1行目: ヘッダー行（カラム名）
- jisCode は全行必須。**未設定行はエラーになりJOINに失敗します**

---

## CSV投入手順

```bash
# 1. CSVを配置
#    data/raw/national/municipalities.csv  ← 全国市区町村マスター
#    data/raw/national/shelters.csv        ← 全国避難所データ（国土地理院等から取得）

# 2. 全国ビルド（strict モード: エラーがあれば即停止）
npm run data:build:national

# == 内部で以下が順番に実行されます ==
# npm run master:generate        # municipalities.csv → municipalities-base.json（スコア引き継ぎ）
# npm run import:shelters:national # shelters.csv → data/processed/shelters.json
# npm run merge:data:strict       # municipalities-base.json + shelters.json → municipalities.json
# npm run validate:data -- --strict # 品質チェック（jisCode未設定・search-index不一致はエラー）
```

---

## エラー時の見方

### `必須カラムが不足しています`
→ CSVのヘッダー行を確認してください。カラム名のスペル・大文字小文字を確認。

### `バリデーションエラー: N行`
→ エラー行番号とフィールド名が出力されます。該当CSVの行を確認してください。

### `同一jisCode混在エラー`
→ 同じ jisCode に異なる prefecture/municipality が入っています。CSVのjisCode列を確認してください。

### `🔒 STRICT MODE エラー: フォールバックJOIN`
→ jisCode が municipalities-base.json と一致していません。両CSVのjisCodeを照合してください。

### `🔒 STRICT MODE エラー: 避難所データJOIN失敗`
→ shelters.csv に含まれている jisCode が municipalities.csv に存在しません。

### `search-index 件数不一致`
→ `npm run merge:data` を再実行してください。

---

## data:build:national の strict モード停止条件

| 条件 | 説明 |
|---|---|
| jisCode 未設定・不正形式 | municipalities.csv / shelters.csv 内 |
| 同一jisCode に prefecture/municipality が混在 | shelters.csv 内 |
| フォールバックJOIN発生 | jisCodeが一致しない場合に prefecture_municipality で結合 |
| shelters.json の未使用エントリ | shelters.csvの自治体がmunicipalities-base.jsonに存在しない |
| search-index 件数・内容不一致 | merge後に自動チェック |
| sourceUrl 未設定 | shelters.csv の各行 |
| updatedAt 未設定・形式不正 | shelters.csv の各行 |
| shelters.json 不在・スキーマ違反 | strict 検証時に error |

---

## 実CSV投入前チェックリスト

- [ ] jisCode が5桁数字であること
- [ ] municipalities.csv と shelters.csv の jisCode が一致していること
- [ ] shelters.csv の sourceUrl が有効なURLであること
- [ ] shelters.csv の updatedAt が YYYY-MM-DD 形式であること
- [ ] 文字コードが UTF-8 であること
- [ ] ヘッダー行のカラム名が正確であること（スペース・全角文字に注意）
- [ ] `npm run data:build:national` が strict モードで通過すること
- [ ] `npm run build` が成功すること
