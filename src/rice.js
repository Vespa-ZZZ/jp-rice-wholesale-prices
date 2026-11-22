import * as cheerio from 'cheerio';

export const LIST_URL = 'https://www.maff.go.jp/j/seisan/keikaku/soukatu/aitaikakaku.html';
export const HOST = 'www.maff.go.jp';
export const SOURCE = 'Ministry of Agriculture, Forestry and Fisheries (MAFF), Japan — 米の相対取引価格・数量 (contract prices and volumes of rice between shippers and wholesalers). Processed by this Actor.';
export const NATIONAL_LABEL = '全銘柄平均価格、合計数量';

const reiwa = (n) => 2018 + Number(n);
const nfkc = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');

/**
 * Monthly files listed on the MAFF page: one list item per month and crop year, labelled
 * "令和7年産米の相対取引価格・数量（令和8年1月）（速報）", with a CSV link. Fails if a labelled item has no CSV or if the
 * same month and crop year appears twice.
 */
export function monthlyFiles(html) {
    const $ = cheerio.load(html);
    const files = new Map();
    $('li').each((_, li) => {
        const label = nfkc($(li).text());
        const m = /令和(\d{1,2})年産米の相対取引価格・数量\(令和(\d{1,2})年(\d{1,2})月\)/.exec(label);
        if (!m) return;
        const csv = $(li).find('a[href$=".csv"]').attr('href');
        const cropYear = reiwa(m[1]);
        const month = `${reiwa(m[2])}-${String(Number(m[3])).padStart(2, '0')}`;
        if (Number(m[3]) < 1 || Number(m[3]) > 12) throw new Error(`Unexpected month in MAFF label "${label}"`);
        if (!csv) throw new Error(`No CSV link for ${month} (crop ${cropYear}) on the MAFF page`);
        const url = new URL(csv, LIST_URL);
        if (url.protocol !== 'https:' || url.hostname !== HOST) throw new Error(`Unexpected file host: ${url.hostname}`);
        const key = `${cropYear}|${month}`;
        if (files.has(key)) throw new Error(`The MAFF page lists ${month} (crop ${cropYear}) twice`);
        files.set(key, { cropYear, month, url: url.href, preliminary: label.includes('速報'), corrected: label.includes('正誤表') });
    });
    if (!files.size) throw new Error('No monthly rice price files were found on the MAFF page (layout changed?)');
    // Structural check: every CSV item in the lists that hold the monthly price files must be readable. A renamed or
    // reworded item there is a format change, never something to skip.
    $('ul').each((_, ul) => {
        const items = $(ul).children('li');
        const isPriceList = items.toArray().some((li) => /令和\d{1,2}年産米の相対取引価格・数量\(令和\d{1,2}年\d{1,2}月\)/.test(nfkc($(li).text())));
        if (!isPriceList) return;
        items.each((__, li) => {
            if (!$(li).find('a[href$=".csv"]').length) return;
            if (!/令和\d{1,2}年産米の相対取引価格・数量\(令和\d{1,2}年\d{1,2}月\)/.test(nfkc($(li).text()))) {
                throw new Error(`Unrecognised monthly item on the MAFF page: "${nfkc($(li).text()).slice(0, 80)}"`);
            }
        });
    });
    return [...files.values()].sort((a, b) => b.month.localeCompare(a.month) || b.cropYear - a.cropYear);
}

/** Minimal RFC 4180 CSV parser (quoted fields with commas). */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (quoted) throw new Error('The CSV ends inside a quoted field (truncated download?)');
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** "21,392" → 21392, "-" or empty → null; anything else is a format change. */
export function num(v, where) {
    const s = nfkc(v);
    if (s === '' || s === '-' || s === '－' || s === '…') return null;
    if (!/^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Unexpected value "${String(v).slice(0, 20)}" at ${where}`);
    return Number(s.replace(/,/g, ''));
}

/**
 * Parse one monthly CSV. Columns are found by their labels, and the month and crop year in the labels must match the
 * file's list entry (e.g. "8年10月_価格（8年産米）" for October 2026, crop 2026).
 */
export function parseMonthly(text, file) {
    let rows;
    try {
        rows = parseCsv(String(text).replace(/^﻿/, ''));
    } catch (err) {
        throw new Error(`MAFF file for ${file.month} (crop ${file.cropYear}): ${err.message}`);
    }
    if (rows.length < 2) throw new Error(`The MAFF file for ${file.month} is empty`);
    const header = rows[0].map(nfkc);
    const [y, m] = file.month.split('-').map(Number);
    const ym = `${y - 2018}年${m}月`;
    const cy = `${file.cropYear - 2018}年産`;
    const col = (re, what) => {
        const i = header.findIndex((h) => re.test(h));
        if (i < 0) throw new Error(`MAFF file for ${file.month} (crop ${file.cropYear}): column "${what}" not found (layout changed?)`);
        return i;
    };
    const esc = (s) => s.replace(/[()]/g, '\\$&');
    const priceRe = new RegExp(`^${ym}_価格\\(${esc(cy)}米\\)$`);
    const c = {
        pref: col(/^産地$/, '産地'),
        variety: col(/^品種銘柄$/, '品種銘柄'),
        price: col(priceRe, `${ym}_価格（${cy}米）`),
        qty: col(new RegExp(`^${ym}_数量\\(${esc(cy)}米\\)$`), `${ym}_数量（${cy}米）`),
    };
    // Crop-year average to date. In the first month of a crop year MAFF repeats the month's price column instead.
    c.avg = header.findIndex((h) => new RegExp(`^出回り[~～]${ym}_年産平均価格\\(${esc(cy)}\\)$`).test(h));
    if (c.avg < 0) c.avg = header.findIndex((h, i) => i > c.price && priceRe.test(h));
    if (c.avg < 0) col(/$^/, `出回り～${ym}_年産平均価格（${cy}）`);
    // Previous crop year's average, up to the month MAFF uses as comparison base (not always the same month).
    const prevRe = new RegExp(`^出回り[~～]([0-9]+)年([0-9]+)月_年産平均価格\\(${file.cropYear - 2019}年産\\)$`);
    c.prevAvg = col(prevRe, `出回り～…_年産平均価格（${file.cropYear - 2019}年産）`);
    const pm = prevRe.exec(header[c.prevAvg]);
    const previousAverageUntil = `${2018 + Number(pm[1])}-${String(Number(pm[2])).padStart(2, '0')}`;
    // The file also carries previous-month and previous-year comparison columns; the current month must come first.
    const firstPrice = header.findIndex((h) => /^[0-9]+年[0-9]+月_価格/.test(h));
    if (firstPrice !== c.price) throw new Error(`MAFF file listed as ${file.month} (crop ${file.cropYear}) starts with column "${rows[0][firstPrice]}"; the file and its label disagree`);
    const out = [];
    const seen = new Set();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.length !== rows[0].length) throw new Error(`MAFF file for ${file.month} (crop ${file.cropYear}), line ${r + 1}: ${row.length} fields instead of ${rows[0].length} (truncated or changed file)`);
        const where = (k) => `${file.month} crop ${file.cropYear}, line ${r + 1}, column ${rows[0][c[k]] ?? k}`;
        const prefectureJa = String(row[c.pref] ?? '').trim();
        const varietyJa = String(row[c.variety] ?? '').trim();
        const national = nfkc(prefectureJa) === nfkc(NATIONAL_LABEL);
        if (!national && (!prefectureJa || !varietyJa)) throw new Error(`Missing prefecture or variety at ${where('pref')}`);
        const key = national ? '*' : `${prefectureJa}|${varietyJa}`;
        if (seen.has(key)) throw new Error(`Duplicate row for ${key} at ${where('pref')}`);
        seen.add(key);
        out.push({
            tradeMonth: file.month,
            cropYear: file.cropYear,
            prefectureJa: national ? null : prefectureJa,
            varietyJa: national ? null : varietyJa,
            isNationalTotal: national,
            priceYenPer60kg: num(row[c.price], where('price')),
            quantityTonnes: num(row[c.qty], where('qty')),
            cropYearAveragePriceYenPer60kg: num(row[c.avg], where('avg')),
            previousCropYearAveragePriceYenPer60kg: num(row[c.prevAvg], where('prevAvg')),
            previousCropYearAverageUntil: previousAverageUntil,
            isPreliminary: file.preliminary,
            sourceFileUrl: file.url,
        });
    }
    if (!out.some((x) => x.isNationalTotal)) throw new Error(`MAFF file for ${file.month} (crop ${file.cropYear}) has no national total row (layout changed?)`);
    return out;
}

export const normalizeForSearch = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
