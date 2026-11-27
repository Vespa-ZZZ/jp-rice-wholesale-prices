import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthlyFiles, num, parseCsv, parseMonthly, sanitize } from '../src/rice.js';
import { run } from '../src/run.js';

const LIST = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8');
const CSV = readFileSync(new URL('./fixtures/r8-2026-10.csv', import.meta.url), 'utf8');
const OCT = { cropYear: 2026, month: '2026-10', url: 'https://www.maff.go.jp/j/seisan/keikaku/soukatu/0810_08nensan_kakaku.csv', preliminary: true };

test('monthlyFiles: labels map to month and crop year; other CSVs ignored', () => {
    const f = monthlyFiles(LIST);
    assert.equal(f.length, 4);
    assert.deepEqual(f[0], { cropYear: 2026, month: '2026-10', url: OCT.url, preliminary: true, corrected: false });
    assert.ok(f.some((x) => x.month === '2025-09' && x.cropYear === 2025));
    assert.ok(f.some((x) => x.month === '2025-11' && x.corrected));
    assert.ok(!f.some((x) => /aitaikakaku-298/.test(x.url)));
    assert.throws(() => monthlyFiles('<li>令和8年産米の相対取引価格・数量（令和8年10月）（速報）PDF</li>'), /No CSV link/);
    assert.throws(() => monthlyFiles('<p>moved</p>'), /No monthly rice price files/);
    const dup = '<li>令和8年産米の相対取引価格・数量（令和8年10月）<a href="./a.csv">CSV</a></li>';
    assert.throws(() => monthlyFiles(dup + dup.replace('a.csv', 'b.csv')), /twice/);
    assert.throws(() => monthlyFiles('<li>令和8年産米の相対取引価格・数量（令和8年10月）<a href="https://evil.example/a.csv">CSV</a></li>'), /Unexpected file host/);
});

test('parseCsv / num', () => {
    assert.deepEqual(parseCsv('a,"1,234",-\r\nb,"x""y",\n'), [['a', '1,234', '-'], ['b', 'x"y', '']]);
    assert.equal(num('"21,392"'.replace(/"/g, ''), 'x'), 21392);
    assert.equal(num('-', 'x'), null);
    assert.equal(num('', 'x'), null);
    assert.throws(() => num('約2万', 'here'), /Unexpected value .* at here/);
    const p = ['C:', 'Us' + 'ers', 'someone', 'x.js'].join('\\');
    assert.equal(sanitize(`at ${p}`), 'at <path>');
});

test('parseMonthly: real October 2026 file', () => {
    const rows = parseMonthly(CSV, OCT);
    assert.equal(rows.length, 121);
    const uonuma = rows.find((r) => r.prefectureJa === '新潟' && r.varietyJa === 'コシヒカリ（魚沼）');
    assert.equal(uonuma.priceYenPer60kg, 27734);
    assert.equal(uonuma.quantityTonnes, 1733);
    assert.equal(uonuma.cropYearAveragePriceYenPer60kg, 26593);
    assert.equal(uonuma.previousCropYearAveragePriceYenPer60kg, 40682);
    assert.equal(uonuma.previousCropYearAverageUntil, '2026-10');
    const nat = rows.find((r) => r.isNationalTotal);
    assert.deepEqual([nat.prefectureJa, nat.priceYenPer60kg, nat.quantityTonnes], [null, 21434, 103970]);
    const blank = rows.find((r) => r.prefectureJa === '熊本' && r.varietyJa === '森のくまさん');
    assert.equal(blank.priceYenPer60kg, null);
    assert.equal(blank.quantityTonnes, null);
});

test('parseMonthly: header for another month / crop year, missing national row, bad values fail', () => {
    assert.throws(() => parseMonthly(CSV, { ...OCT, month: '2026-09' }), /not found|disagree/);
    const swapped = CSV.replace(/^﻿?産地,品種銘柄,8年10月_価格（8年産米）/, '産地,品種銘柄,8年9月_価格（8年産米）').replace('8年9月_価格（8年産米）,対前月比', '8年10月_価格（8年産米）,対前月比');
    assert.throws(() => parseMonthly(swapped, OCT), /disagree/);
    assert.throws(() => parseMonthly(CSV, { ...OCT, cropYear: 2025 }), /not found/);
    const noNat = CSV.split(/\r?\n/).filter((l) => !l.startsWith('全銘柄')).join('\n');
    assert.throws(() => parseMonthly(noNat, OCT), /no national total row/);
    const bad = CSV.replace('"27,734"', '"非公表"');
    assert.throws(() => parseMonthly(bad, OCT), /Unexpected value "非公表"/);
    const dup = CSV.replace('新潟,コシヒカリ（佐渡）', '新潟,コシヒカリ（魚沼）');
    assert.throws(() => parseMonthly(dup, OCT), /Duplicate row/);
});

// ---- run() ----
function fakeActor(input, kv = new Map()) {
    const records = [];
    const values = {};
    const lifecycle = [];
    return {
        records, values, lifecycle, chargeLimit: Infinity,
        init: async () => lifecycle.push('init'),
        getInput: async () => input,
        async pushData(items) {
            const take = items.slice(0, Math.max(0, this.chargeLimit - records.length));
            records.push(...take);
            return { eventChargeLimitReached: take.length < items.length, chargedCount: take.length };
        },
        setValue: async (k, v) => { values[k] = v; },
        openKeyValueStore: async () => ({ getValue: async (k) => structuredClone(kv.get(k) ?? null), setValue: async (k, v) => kv.set(k, structuredClone(v)) }),
        exit: async () => lifecycle.push('exit'),
        fail: async (m) => lifecycle.push('fail', m),
    };
}
const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), text: async () => body });
const log = { info() {}, warning() {}, error() {} };
const site = (csv = CSV) => async (url) => (url.endsWith('.html') ? ok(LIST) : ok(url.endsWith('0810_08nensan_kakaku.csv') ? csv : 'x'));
async function exec(input, { actor = fakeActor(input), fetchImpl = site() } = {}) {
    const calls = [];
    await run({ actor, log, fetchImpl: async (u) => { calls.push(u); return fetchImpl(u); }, sleep: async () => {}, intervalMs: 0 });
    actor.calls = calls;
    return actor;
}

test('run: latest month by default, filters, national row', async () => {
    const all = await exec({});
    assert.deepEqual(all.lifecycle, ['init', 'exit']);
    assert.equal(all.records.length, 121);
    assert.equal(all.calls.length, 2);
    assert.match(all.records[0].source, /MAFF/);
    const ni = await exec({ prefectures: ['新潟'], varieties: ['ｺｼﾋｶﾘ'] });
    assert.equal(ni.records.length, 4);
    assert.ok(ni.records.every((r) => r.prefectureJa === '新潟' && !r.isNationalTotal));
    const noNat = await exec({ includeNationalTotal: false });
    assert.equal(noNat.records.length, 120);
});

test('run: bad input, unknown month, layout change', async () => {
    assert.match((await exec({ months: ['2026/10'] })).lifecycle[2], /2026-10/);
    assert.match((await exec({ months: ['2019-01'] })).lifecycle[2], /No MAFF file for 2019-01/);
    assert.match((await exec({ stateKey: 1 })).lifecycle[2], /stateKey/);
    assert.match((await exec({}, { fetchImpl: site(CSV.replace('品種銘柄', '銘柄')) })).lifecycle[2], /column "品種銘柄" not found/);
});

test('monitoring: new rows once, revisions detected, spending limit keeps the rest', async () => {
    const kv = new Map();
    const input = { onlyNew: true, stateKey: 'm', months: ['2026-10'] };
    const a = fakeActor(input, kv);
    a.chargeLimit = 50;
    await exec(input, { actor: a });
    assert.equal(a.records.length, 50);
    assert.equal(a.values.RUN_SUMMARY.stopReason, 'spendingLimit');
    const b = await exec(input, { actor: fakeActor(input, kv) });
    assert.equal(b.records.length, 71);
    assert.equal((await exec(input, { actor: fakeActor(input, kv) })).records.length, 0);
    const fixed = await exec(input, { actor: fakeActor(input, kv), fetchImpl: site(CSV.replace('"27,734"', '"27,800"')) });
    assert.equal(fixed.records.length, 1);
    assert.equal(fixed.records[0].changeType, 'revision');
    assert.equal(fixed.records[0].priceYenPer60kg, 27800);
});

test('older layouts: first month of a crop year, previous average to another month', () => {
    const sep = '﻿産地,品種銘柄,7年9月_価格（7年産米）,7年9月_数量（7年産米）,7年9月_価格（7年産米）,出回り～7年9月_年産平均価格（6年産）,対前年比\n'
        + '新潟,コシヒカリ（一般）,"30,000",100,"30,000","24,000",125%\n全銘柄平均価格、合計数量,,"29,000","1,000","29,000","23,000",126%\n';
    const r = parseMonthly(sep, { cropYear: 2025, month: '2025-09', url: 'u', preliminary: true });
    assert.deepEqual([r[0].priceYenPer60kg, r[0].cropYearAveragePriceYenPer60kg, r[0].previousCropYearAverageUntil], [30000, 30000, '2025-09']);
    const aug = '産地,品種銘柄,8年8月_価格（7年産米）,8年8月_数量（7年産米）,出回り～8年8月_年産平均価格（7年産）,出回り～7年10月_年産平均価格（6年産）,対前年比\n'
        + '全銘柄平均価格、合計数量,,"36,000","10,000","37,000","24,000",150%\n';
    const a = parseMonthly(aug, { cropYear: 2025, month: '2026-08', url: 'u', preliminary: true });
    assert.equal(a[0].previousCropYearAverageUntil, '2025-10');
});

test('review round 1: monitoring reads every month first; truncated CSV; shortfall; version check; exact limit', async () => {
    // Monitoring without months requests all 4 listed files before pushing anything; a bad file means no output.
    const m = await exec({ onlyNew: true, stateKey: 'all' });
    assert.ok(m.calls.length >= 3, 'stops at the first bad file, before any output');
    assert.equal(m.records.length, 0);
    assert.equal(m.lifecycle[1], 'fail');
    // Truncated download (unclosed quote) and short rows fail.
    assert.throws(() => parseMonthly(CSV.slice(0, CSV.lastIndexOf('"21,434"') + 3), OCT), /quoted field/);
    assert.throws(() => parseMonthly(CSV.replace('北海道,ななつぼし,"21,392","11,160"', '北海道,ななつぼし,"21,392"'), OCT), /fields instead of 15/);
    // Asking for more months than listed is reported.
    const many = await exec({ latestMonths: 24, months: [] }, { fetchImpl: async (u) => (u.endsWith('.html') ? ok(LIST.replace(/<li>[\s\S]*?<\/li>/g, (li) => (li.includes('0810_08nensan') ? li : ''))) : ok(CSV)) });
    assert.equal(many.values.RUN_SUMMARY.monthsShortfall, 23);
    assert.equal(many.values.RUN_SUMMARY.incomplete, true);
    // The previous-average comparison month is part of the fingerprint.
    const kv = new Map();
    const input = { onlyNew: true, stateKey: 'u', months: ['2026-10'] };
    await exec(input, { actor: fakeActor(input, kv) });
    const moved = await exec(input, { actor: fakeActor(input, kv), fetchImpl: site(CSV.replace('出回り～8年10月_年産平均価格（7年産）', '出回り～8年9月_年産平均価格（7年産）')) });
    assert.equal(moved.records.length, 121);
    assert.ok(moved.records.every((r) => r.changeType === 'revision'));
    // Another run changed the state in between: no overwrite.
    const a = fakeActor(input, kv);
    const push = a.pushData.bind(a);
    a.pushData = async (items) => { kv.set('rows-u', { ...kv.get('rows-u'), version: 999 }); return push(items); };
    await exec(input, { actor: a, fetchImpl: site(CSV.replace('"27,734"', '"27,999"')) });
    assert.match(a.lifecycle[2], /changed by another run/);
    // Limit reached exactly with everything saved; zero room; out-of-range charge result.
    const exact = fakeActor({ months: ['2026-10'] });
    exact.pushData = async (items) => { exact.records.push(...items); return { eventChargeLimitReached: true, chargedCount: items.length }; };
    await exec({ months: ['2026-10'] }, { actor: exact });
    assert.equal(exact.values.RUN_SUMMARY.stopReason, null);
    const none = fakeActor({ onlyNew: true, stateKey: 'z', months: ['2026-10'] }, new Map());
    none.chargeLimit = 0;
    await exec({ onlyNew: true, stateKey: 'z', months: ['2026-10'] }, { actor: none });
    assert.equal(none.values.RUN_SUMMARY.stopReason, 'spendingLimit');
    const weird = fakeActor({ months: ['2026-10'] });
    weird.pushData = async () => ({ eventChargeLimitReached: true, chargedCount: 9999 });
    await exec({ months: ['2026-10'] }, { actor: weird });
    assert.match(weird.lifecycle[2], /Unexpected charge result/);
});

test('review round 2: older-month revision, pending months retried off-list, unrecognised items, legacy state, lock', async () => {
    const SEP = readFileSync(new URL('./fixtures/r7-2025-09.csv', import.meta.url), 'utf8');
    const two = LIST.replace(/<li>[\s\S]*?<\/li>/g, (li) => (/0810_08nensan|aitaikakaku-250/.test(li) ? li : ''));
    const oct = LIST.replace(/<li>[\s\S]*?<\/li>/g, (li) => (/0810_08nensan/.test(li) ? li : ''));
    const serve = (list, files) => async (u) => (u.endsWith('.html') ? ok(list) : files[u.split('/').pop()] !== undefined ? ok(files[u.split('/').pop()]) : { ok: false, status: 404, headers: new Headers(), text: async () => '' });
    const kv = new Map();
    const input = { onlyNew: true, stateKey: 'r2' };
    const base = { '0810_08nensan_kakaku.csv': CSV, 'aitaikakaku-250.csv': SEP };
    const first = await exec(input, { actor: fakeActor(input, kv), fetchImpl: serve(two, base) });
    assert.equal(first.lifecycle[1], 'exit');
    const n = first.records.length;
    assert.ok(n > 121);
    // MAFF corrects September 2025 only.
    const fixed = await exec(input, { actor: fakeActor(input, kv), fetchImpl: serve(two, { ...base, 'aitaikakaku-250.csv': SEP.replace('"36,540","7,622","36,540"', '"36,600","7,622","36,600"') }) });
    assert.equal(fixed.records.length, 1);
    assert.deepEqual([fixed.records[0].tradeMonth, fixed.records[0].changeType, fixed.records[0].priceYenPer60kg], ['2025-09', 'revision', 36600]);
    // A run stopped by the spending limit leaves September pending; MAFF then drops it from the list page.
    const kv2 = new Map();
    const s1 = fakeActor(input, kv2);
    s1.chargeLimit = 130;
    await exec(input, { actor: s1, fetchImpl: serve(two, base) });
    assert.ok(Object.keys(kv2.get('rows-r2').pending).length >= 1);
    const s2 = await exec(input, { actor: fakeActor(input, kv2), fetchImpl: serve(oct, base) });
    assert.equal(s1.records.length + s2.records.length, n);
    assert.deepEqual(kv2.get('rows-r2').pending, {});
    // Pending month no longer downloadable: reported, not silently dropped.
    const kv3 = new Map();
    const t1 = fakeActor(input, kv3);
    t1.chargeLimit = 130;
    await exec(input, { actor: t1, fetchImpl: serve(two, base) });
    const t2 = await exec(input, { actor: fakeActor(input, kv3), fetchImpl: serve(oct, { '0810_08nensan_kakaku.csv': CSV }) });
    assert.equal(t2.values.RUN_SUMMARY.incomplete, true);
    assert.ok(t2.values.RUN_SUMMARY.pendingUnavailable.length >= 1);
    // An unreadable monthly item fails instead of being skipped.
    assert.throws(() => monthlyFiles('<li>令和8年産米の相対取引価格・数量（10月分・暫定）<a href="./x.csv">CSV</a></li>'), /Unrecognised monthly item|No monthly rice price files/);
    // Legacy flat state is accepted (rows reported once more as revisions at most).
    const kv4 = new Map([['rows-l', { 'x|y': 'abc' }]]);
    const leg = await exec({ onlyNew: true, stateKey: 'l', months: ['2026-10'] }, { actor: fakeActor({ onlyNew: true, stateKey: 'l', months: ['2026-10'] }, kv4) });
    assert.deepEqual(leg.lifecycle, ['init', 'exit']);
    assert.equal(kv4.get('rows-l').version, 1);
    // Lost lock race.
    const kv5 = new Map();
    const raced = fakeActor(input, kv5);
    raced.openKeyValueStore = async () => ({
        getValue: async (k) => structuredClone(kv5.get(k) ?? null),
        setValue: async (k, v) => { kv5.set(k, structuredClone(v)); if (k === 'lock-r2' && v) kv5.set(k, { runId: 'rival', at: v.at }); },
    });
    assert.match((await exec(input, { actor: raced, fetchImpl: serve(two, base) })).lifecycle[2], /started at the same time/);
});

test('review round 3: reworded item in the price list, explicit months with pending, lock lost before output', async () => {
    const reworded = LIST.replace('令和8年産米の相対取引価格・数量（令和8年10月）', '令和8年産米の相対取引価格及び数量（令和8年10月）');
    assert.throws(() => monthlyFiles(reworded), /Unrecognised monthly item/);
    // Explicit month that has left the list but is still pending from an earlier run.
    const SEP = readFileSync(new URL('./fixtures/r7-2025-09.csv', import.meta.url), 'utf8');
    const oct = LIST.replace(/<li>[\s\S]*?<\/li>/g, (li) => (/0810_08nensan/.test(li) ? li : ''));
    const kv = new Map([['rows-p', { version: 1, rows: {}, pending: { '2025|2025-09': { cropYear: 2025, month: '2025-09', url: 'https://www.maff.go.jp/j/seisan/keikaku/soukatu/attach/other/aitaikakaku-250.csv', preliminary: true } } }]]);
    const input = { onlyNew: true, stateKey: 'p', months: ['2025-09'] };
    const r = await exec(input, { actor: fakeActor(input, kv), fetchImpl: async (u) => (u.endsWith('.html') ? ok(oct) : ok(SEP)) });
    assert.deepEqual(r.lifecycle, ['init', 'exit']);
    assert.ok(r.records.length > 0 && r.records.every((x) => x.tradeMonth === '2025-09'));
    assert.deepEqual(kv.get('rows-p').pending, {});
    // Lock taken over while files are downloaded: nothing is pushed.
    const kv2 = new Map();
    const input2 = { onlyNew: true, stateKey: 'q', months: ['2026-10'] };
    const a = fakeActor(input2, kv2);
    const fetchImpl = async (u) => { if (u.endsWith('.csv')) kv2.set('lock-q', { runId: 'rival', at: new Date().toISOString() }); return site()(u); };
    await exec(input2, { actor: a, fetchImpl });
    assert.match(a.lifecycle[2], /took over/);
    assert.equal(a.records.length, 0);
});

test('prechecks the dataset item budget and allows non-PPE output', async () => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const input = {};
        const actor = fakeActor(input);
        configureActor(actor, actor.records);
        await exec(input, { actor });
        assert.deepEqual(actor.lifecycle, ['init', 'exit']);
        assert.equal(actor.records.length, isPayPerEvent ? budget : 121);
        assert.equal(actor.values.RUN_SUMMARY.pushed, actor.records.length);
        assert.equal(actor.values.RUN_SUMMARY.stopReason, isPayPerEvent ? 'spendingLimit' : null);
    }
});
