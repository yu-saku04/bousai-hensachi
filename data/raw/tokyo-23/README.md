# 東京23区 実データ収集ガイド

> 全国防災偏差値 実データ投入フェーズ — 東京23区パイロット

東京23区を第1弾の実データ投入対象とします。
全国でオープンデータが最も整備されており、検証しやすいためです。

---

## 収集予定データ一覧

| データ名 | 提供元 | 対応スコア | 形式 | 状態 |
|---|---|---|---|---|
| 洪水浸水想定区域図 | 東京都建設局 | floodRisk | GeoJSON | 収集済 |
| 土砂災害警戒区域 | 東京都建設局 | floodRisk / isolationRisk | GeoJSON | 収集済 |
| 避難所・収容人数 | 東京都 / 各区 | shelterCapacity | CSV | 収集済 |
| 国勢調査2020（人口・高齢化率） | 総務省統計局 | agingRisk / isolationRisk | CSV | 収集済 |
| 火災統計（区別発生件数） | 東京消防庁 | fireRisk | CSV / PDF | 収集予定 |
| 震度分布推計（J-SHIS集計） | 防災科研 | earthquakeRisk | メッシュCSV | 収集予定 |
| 地域包括支援センター | 東京都福祉局 | socialSupportScore | CSV | 収集予定 |
| 福祉施設密度 | 厚生労働省 | emotionalRecoveryRisk | CSV | 未着手 |

---

## データ提供元と取得先 URL

### 1. 洪水ハザードマップ（東京都）
- URL: https://www.kensetsu.metro.tokyo.lg.jp/
- 備考: 荒川・多摩川・中小河川の各ハザードマップをGeoJSONで取得。
  ゼロメートル地帯（江東区・江戸川区・墨田区等）は浸水深が特に深いため要注意。

### 2. 指定緊急避難場所・避難所（東京都オープンデータ）
- URL: https://catalog.data.metro.tokyo.lg.jp/
- データセット名: 「避難所」「指定緊急避難場所」
- 備考: 区ごとにCSVが異なる場合あり。収容人数・バリアフリー対応・食料備蓄の列を確認すること。

### 3. 国勢調査2020（総務省統計局）
- URL: https://www.stat.go.jp/data/kokusei/2020/kekka.html
- 取得方法: e-Stat API または CSVダウンロード
- 取得カラム: 総人口、65歳以上人口、65歳以上1人暮らし世帯、15歳未満人口、総世帯数

### 4. 火災統計（東京消防庁）
- URL: https://www.tfd.metro.tokyo.lg.jp/
- 備考: 年次報告書から区別発生件数を抽出。直近5年分の平均を使用する。

### 5. J-SHIS 地震動予測（防災科研）
- URL: https://www.j-shis.bosai.go.jp/map/
- 備考: 250mメッシュデータをダウンロードし、区単位で人口加重平均して集計。
  30年以内震度6弱以上確率を主指標として使用。

### 6. 地域包括支援センター（東京都福祉局）
- URL: https://www.fukushi.metro.tokyo.lg.jp/
- 備考: 区別センター数と高齢者人口から密度を算出。socialSupportScore に反映。

---

## 対応スコアと変換方針

| スコア | 使用データ | 変換方針 |
|---|---|---|
| floodRisk | 浸水深（最大）、浸水面積率 | 低いほど高スコア（normalizeLowerIsBetter） |
| earthquakeRisk | 30年内震度6弱以上確率 | 低いほど高スコア（normalizeLowerIsBetter） |
| fireRisk | 人口1万人あたり年間発生件数 | 低いほど高スコア（normalizeLowerIsBetter） |
| agingRisk | 高齢化率（65歳以上比率） | 低いほど高スコア（normalizeLowerIsBetter） |
| shelterCapacity | 住民1人あたり収容可能人数 | 高いほど高スコア（normalizeHigherIsBetter） |
| isolationRisk | 1人暮らし高齢者比率 | 低いほど高スコア（normalizeLowerIsBetter） |
| socialSupportScore | 地域包括支援センター密度 | 高いほど高スコア（normalizeHigherIsBetter） |

---

## 取得手順（ステップバイステップ）

```bash
# 1. ディレクトリ準備
mkdir -p data/raw/tokyo-23

# 2. 避難所CSVを東京都オープンデータカタログからダウンロード
# → data/raw/tokyo-23/shelters.csv に保存

# 3. 国勢調査データをe-Statから取得
# → data/raw/tokyo-23/census-2020.csv に保存

# 4. 各 importer を実行
npx ts-node scripts/importers/import-shelters.ts \
  --input data/raw/tokyo-23/shelters.csv \
  --output data/processed/tokyo-23-shelter-scores.json

npx ts-node scripts/importers/import-population.ts \
  --input data/raw/tokyo-23/census-2020.csv \
  --output data/processed/tokyo-23-population-scores.json

# 5. 統合
npx ts-node scripts/merge-datasets.ts \
  --base src/data/municipalities.json \
  --processed data/processed/ \
  --output src/data/municipalities.json

# 6. 検証
npx ts-node scripts/validate-datasets.ts \
  --input src/data/municipalities.json

# 7. ビルド確認
npm run build
```

---

## 注意点・ライセンス

- **東京都オープンデータ**: CC BY 4.0。出典表記「東京都」が必要。
- **国土地理院データ**: 測量法第29条に基づく複製承認を要する場合あり。営利利用は事前確認を。
- **消防庁統計**: 政府標準利用規約（CC BY 4.0相当）。
- **防災科研 J-SHIS**: CC BY 4.0。
- **総務省統計局**: 統計法第32条に基づく承認申請が必要な場合あり（加工利用の場合）。

いずれのデータも「参考値」として扱い、sourceNote フィールドに出典を明記すること。

---

## データ品質チェックリスト

収集後・投入前に以下を確認すること：

- [ ] CSVのエンコーディング確認（UTF-8 または Shift-JIS → UTF-8変換）
- [ ] 市区町村コードの整合性（5桁JISコード）
- [ ] 収容人数が0または異常値の行の除外
- [ ] 廃止・統廃合済み避難所の除外
- [ ] 年次データの集計期間の統一
- [ ] `npx ts-node scripts/validate-datasets.ts` でエラーなし
