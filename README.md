# Japan Rice Prices by Prefecture & Variety (MAFF Monthly)

Monthly **contract prices and volumes of Japanese rice** (相対取引価格・数量) by producing prefecture and variety —
Niigata Koshihikari (Uonuma, Sado, general …), Hokkaido Yumepirika, Akita Akitakomachi and about 120 others — as published
by Japan's Ministry of Agriculture, Forestry and Fisheries (MAFF). Includes the national average price and total
volume, crop-year averages to date and the previous crop year's average for comparison.

These are the prices agreed between shippers (JA groups and other collectors) and wholesalers — the reference price for
the Japanese rice market. Typical users: food manufacturers, restaurant chains and retailers buying rice, commodity
analysts and journalists following Japan's rice prices, and AI agents answering "how much does rice cost in Japan".

## What you can do

- Get the **latest month** (default) or any of the months MAFF currently lists (`months`, `latestMonths`).
- Filter by **prefecture** (`新潟`, `北海道` …) and **variety** (`コシヒカリ`, `魚沼`, `ゆめぴりか` …).
- **Monitor** with `onlyNew`: each run re-reads every month MAFF still lists (about 14 small files) and returns only new
  rows and **revised figures** (MAFF corrects preliminary figures, also for earlier months; corrections come back with
  `changeType: "revision"`). Rows left over by a spending limit or `maxItems` are returned by the next run. Run one
  monitor per `stateKey` at a time; a run that finds the state changed by another run stops before pushing more rows.
  After an upgrade from an earlier version of this Actor, the first monitoring run may report already-seen rows once
  more as revisions.

## Input examples

Niigata, latest month:

```json
{ "prefectures": ["新潟"] }
```

Koshihikari everywhere, last six months:

```json
{ "varieties": ["コシヒカリ"], "latestMonths": 6 }
```

Monthly monitor (schedule it weekly):

```json
{ "onlyNew": true, "stateKey": "rice" }
```

Around September a month can belong to two crop years (the old crop's last month and the new crop's first); both are
returned, distinguished by `cropYear`.

## Output example

```json
{
  "tradeMonth": "2026-10",
  "cropYear": 2026,
  "prefectureJa": "新潟",
  "varietyJa": "コシヒカリ（魚沼）",
  "isNationalTotal": false,
  "priceYenPer60kg": 27734,
  "quantityTonnes": 1733,
  "cropYearAveragePriceYenPer60kg": 26593,
  "previousCropYearAveragePriceYenPer60kg": 40682,
  "previousCropYearAverageUntil": "2026-10",
  "isPreliminary": true,
  "sourceFileUrl": "https://www.maff.go.jp/j/seisan/keikaku/soukatu/0810_08nensan_kakaku.csv",
  "source": "Ministry of Agriculture, Forestry and Fisheries (MAFF), Japan — 米の相対取引価格・数量 …"
}
```

- `priceYenPer60kg`: price in yen per 60 kg of brown rice for the month, as published by MAFF (MAFF's notes in the
  monthly PDF define it as the grade-1 price including transport, packaging and consumption tax).
- `quantityTonnes`: contracted volume in tonnes for the month.
- `cropYearAveragePriceYenPer60kg`: average from the start of the crop year to this month; in the first month it equals
  the month's price. `previousCropYearAveragePriceYenPer60kg` is the previous crop year's average up to
  `previousCropYearAverageUntil`, the comparison base MAFF uses.
- The national row has `isNationalTotal: true` and no prefecture or variety (only when no filter is set).
- Figures MAFF leaves blank (`-`, e.g. no contracts that month) are `null`, never 0.

The run fails with a clear message, instead of guessing, if a file's columns do not match its month and crop year, if a
value is not a number, or if the national total row is missing. The run summary (key-value store record `RUN_SUMMARY`)
lists the files read and the months available.

## Data source and terms

- Source: 農林水産省「米の相対取引価格・数量、契約・販売状況、民間在庫の推移等」
  (https://www.maff.go.jp/j/seisan/keikaku/soukatu/aitaikakaku.html). Reused under the MAFF website terms of use
  (compatible with CC BY 4.0) with attribution; **this Actor processes the data** (column selection, number parsing,
  normalised months and crop years).
- Not affiliated with or endorsed by MAFF. One run downloads the list page and one small CSV per month, with a pause
  between requests (MAFF's robots.txt disallows only unrelated procurement paths and sets no crawl delay).
- All selected files are downloaded and checked before anything is output; a truncated or changed file stops the run
  with a clear message. If you ask for more months than MAFF lists, the run summary reports the shortfall.

## 日本語の概要

農林水産省が毎月公表する「米の相対取引価格・数量」を、産地・品種銘柄ごとに取得します（玄米60kg当たりの価格、契約数量、
年産平均価格、前年産平均価格、全銘柄平均）。最新月または指定月、産地・銘柄の絞り込み、速報値の訂正検知（監視モード）に
対応。出典: 農林水産省ウェブサイト（本 Actor で加工）。
