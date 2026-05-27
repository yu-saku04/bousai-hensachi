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
