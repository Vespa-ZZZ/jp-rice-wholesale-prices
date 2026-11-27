import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { pushDataWithinLimit } from './charging.js';
import { HOST, LIST_URL, SOURCE, monthlyFiles, normalizeForSearch, parseMonthly, sanitize } from './rice.js';

const USER_AGENT = 'jp-rice-wholesale-prices-actor/1.0';
const MAX_WAIT_MS = 120000;
const MAX_FILES = 24;
const STATE_STORE = 'jp-rice-wholesale-prices-state';
const LOCK_TTL_MS = 2 * 3600 * 1000;
const LOCK_SETTLE_MS = 3000;

class InputError extends Error {}

function retryAfterMs(res, now) {
    const h = res.headers.get('retry-after');
    if (!h) return 0;
    if (/^\d+$/.test(h)) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - now()) : 0;
}

function makeFetcher({ fetchImpl, sleep, log, now, intervalMs }) {
    let first = true;
    return async (url) => {
        if (new URL(url).hostname !== HOST) throw new Error(`Refusing to fetch from unexpected host ${new URL(url).hostname}`);
        let wait = 0;
        for (let attempt = 0; attempt <= 3; attempt++) {
            if (!first) await sleep(Math.max(wait, attempt === 0 ? intervalMs : intervalMs * 2 ** attempt));
            first = false;
            let res;
            let body;
            try {
                res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000), redirect: 'error' });
                if (res.ok) body = await res.text();
            } catch (err) {
                if (attempt === 3) throw new Error(`Network error for ${url}: ${err.message}`);
                log.warning(`Network error for ${url}, retrying`);
                wait = 0;
                continue;
            }
            if (res.ok) return body;
            if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
            if (attempt === 3) throw new Error(`HTTP ${res.status} for ${url} after retries`);
            wait = retryAfterMs(res, now);
            if (wait > MAX_WAIT_MS) throw new Error(`HTTP ${res.status}; asked to wait ${Math.round(wait / 1000)} s — try again later`);
            log.warning(`HTTP ${res.status} for ${url}, retrying`);
        }
        throw new Error(`Request failed: ${url}`);
    };
}

function readInput(input) {
    const list = (k) => {
        if (input[k] === undefined || input[k] === null) return [];
        if (!Array.isArray(input[k])) throw new InputError(`${k} must be a list.`);
        return input[k].map((x) => String(x).trim()).filter(Boolean);
    };
    const bool = (k, d) => {
        const v = input[k] ?? d;
        if (typeof v !== 'boolean') throw new InputError(`${k} must be true or false.`);
        return v;
    };
    const months = list('months');
    if (months.some((m) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) throw new InputError('months must look like 2026-10.');
    const latestMonths = input.latestMonths ?? 1;
    if (!Number.isInteger(latestMonths) || latestMonths < 1 || latestMonths > MAX_FILES) throw new InputError(`latestMonths must be an integer from 1 to ${MAX_FILES}.`);
    const maxItems = input.maxItems ?? 5000;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100000) throw new InputError('maxItems must be an integer from 1 to 100000.');
    const stateKey = input.stateKey === undefined || input.stateKey === null || input.stateKey === '' ? 'default' : input.stateKey;
    if (typeof stateKey !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50).');
    return {
        months, latestMonths, maxItems, stateKey,
        prefectures: list('prefectures').map(normalizeForSearch),
        varieties: list('varieties').map(normalizeForSearch),
        includeNationalTotal: bool('includeNationalTotal', true),
        onlyNew: bool('onlyNew', false),
    };
}

const fingerprint = (r) => createHash('sha1').update(JSON.stringify([r.priceYenPer60kg, r.quantityTonnes, r.cropYearAveragePriceYenPer60kg, r.previousCropYearAveragePriceYenPer60kg, r.previousCropYearAverageUntil, r.isPreliminary])).digest('hex').slice(0, 16);
const rowKey = (r) => `${r.cropYear}|${r.tradeMonth}|${r.isNationalTotal ? '*' : `${r.prefectureJa}|${r.varietyJa}`}`;

export async function run({ actor, log, fetchImpl = fetch, sleep = delay, now = Date.now, intervalMs = 2000 }) {
    await actor.init();
    let releaseLock = async () => {};
    try {
        const opts = readInput((await actor.getInput()) ?? {});
        const get = makeFetcher({ fetchImpl, sleep, log, now, intervalMs });
        const files = monthlyFiles(await get(LIST_URL));
        const available = [...new Set(files.map((f) => f.month))];
        let wanted;
        let shortfall = 0;
        if (opts.months.length) {
            // Months not on the list page are checked again after unfinished (pending) months are merged in below.
            wanted = new Set(opts.months);
        } else if (opts.onlyNew) {
            // Monitoring re-reads every month MAFF still lists, so corrections of earlier months and rows left over by a
            // previous run (spending limit, maxItems) are picked up.
            wanted = new Set(available);
        } else {
            wanted = new Set(available.slice(0, opts.latestMonths));
            shortfall = Math.max(0, opts.latestMonths - wanted.size);
            if (shortfall) log.warning(`Only ${wanted.size} month(s) are listed by MAFF; ${opts.latestMonths} were requested.`);
        }
        const selected = files.filter((f) => wanted.has(f.month));
        if (selected.length > MAX_FILES) throw new InputError(`Too many files (${selected.length}); request at most ${MAX_FILES} months.`);

        const match = (r) => (r.isNationalTotal ? opts.includeNationalTotal && !opts.prefectures.length && !opts.varieties.length
            : (!opts.prefectures.length || opts.prefectures.includes(normalizeForSearch(r.prefectureJa)))
                && (!opts.varieties.length || opts.varieties.some((v) => normalizeForSearch(r.varietyJa).includes(v))));

        // Monitoring state: soft lock (write, wait, read back) plus a version check before every save. Key-value stores
        // have no atomic lock, so two monitors with the same key are detected and stopped, not merged.
        const store = opts.onlyNew ? await actor.openKeyValueStore(STATE_STORE) : null;
        const stateName = `rows-${opts.stateKey}`;
        const lockName = `lock-${opts.stateKey}`;
        const runId = process.env.APIFY_ACTOR_RUN_ID ?? `local-${now()}-${Math.random().toString(36).slice(2, 8)}`;
        let state = { version: 0, rows: {}, pending: {} };
        if (opts.onlyNew) {
            const lock = await store.getValue(lockName);
            if (lock && lock.runId !== runId && now() - Date.parse(lock.at) < LOCK_TTL_MS) {
                throw new InputError(`Another run with stateKey "${opts.stateKey}" started at ${lock.at} is still in progress (a stale lock expires after 2 hours).`);
            }
            await store.setValue(lockName, { runId, at: new Date(now()).toISOString() });
            await sleep(LOCK_SETTLE_MS);
            if ((await store.getValue(lockName))?.runId !== runId) throw new InputError(`Another run with stateKey "${opts.stateKey}" started at the same time.`);
            releaseLock = async () => { if ((await store.getValue(lockName))?.runId === runId) await store.setValue(lockName, null); };
            const loaded = await store.getValue(stateName);
            // Older format: a flat map of row hashes (without the comparison month) — kept as it is; such rows are
            // reported once more as revisions, which is the safe direction.
            if (loaded && !loaded.rows) state = { version: 0, rows: loaded, pending: {}, legacy: true };
            else if (loaded) state = { pending: {}, ...loaded };
        }
        // Checked before every output batch and every save: a run that lost its lock or whose state was changed by
        // another run stops before pushing anything more.
        const assertOwner = async () => {
            if ((await store.getValue(lockName))?.runId !== runId) throw new Error(`Another run took over stateKey "${opts.stateKey}"; this run stopped.`);
            const cur = await store.getValue(stateName);
            if (!state.legacy && (cur?.version ?? 0) !== (state.version ?? 0)) {
                throw new Error(`The state of stateKey "${opts.stateKey}" was changed by another run; this run stopped. Run one monitor per stateKey at a time.`);
            }
        };
        const saveState = async () => {
            await assertOwner();
            delete state.legacy;
            state.version = (state.version ?? 0) + 1;
            await store.setValue(stateName, state);
        };

        // Files left unfinished by an earlier run (spending limit, maxItems) are retried even after MAFF moves them off
        // the list page; if one can no longer be downloaded the run reports it as incomplete.
        const pendingUnavailable = [];
        if (opts.onlyNew) {
            for (const [key, p] of Object.entries(state.pending ?? {})) {
                if (opts.months.length && !opts.months.includes(p.month)) continue;
                if (selected.some((f) => `${f.cropYear}|${f.month}` === key)) continue;
                if (new URL(p.url).hostname !== HOST) continue;
                selected.push({ cropYear: p.cropYear, month: p.month, url: p.url, preliminary: p.preliminary ?? true, corrected: false });
            }
        }

        if (opts.months.length) {
            const missing = opts.months.filter((m) => !selected.some((f) => f.month === m));
            if (missing.length) throw new InputError(`No MAFF file for ${missing.join(', ')}. Available months: ${available.join(', ')}.`);
        }

        // Download and validate every selected file before anything is output, so a failing file never leaves a
        // partial result behind.
        const parsed = [];
        for (const file of selected) {
            let text;
            try {
                text = await get(file.url);
            } catch (err) {
                if (state.pending?.[`${file.cropYear}|${file.month}`] && !files.includes(file)) { pendingUnavailable.push(file); continue; }
                throw err;
            }
            parsed.push({ file, rows: parseMonthly(text, file) });
        }
        let pushed = 0;
        let truncated = false;
        let limitReached = false;
        let unsaved = 0;
        const processedFiles = [];
        for (const { file, rows } of parsed) {
            const out = [];
            for (const r of rows) {
                if (!match(r)) continue;
                const k = rowKey(r);
                const h = fingerprint(r);
                let changeType = null;
                if (opts.onlyNew) {
                    if (state.rows[k] === h) continue;
                    changeType = state.rows[k] ? 'revision' : 'new';
                }
                if (pushed + out.length >= opts.maxItems) { truncated = true; break; }
                out.push({ row: { ...r, ...(changeType ? { changeType } : {}), source: SOURCE }, k, h });
            }
            if (out.length) {
                if (opts.onlyNew) await assertOwner();
                const res = await pushDataWithinLimit(actor, out.map((o) => o.row));
                let stored = out.length;
                if (res?.eventChargeLimitReached) {
                    limitReached = true;
                    if (!Number.isInteger(res.chargedCount) || res.chargedCount < 0 || res.chargedCount > out.length) {
                        throw new Error('Unexpected charge result from the platform; the monitoring state was not updated for this batch.');
                    }
                    stored = res.chargedCount;
                }
                if (opts.onlyNew && stored) for (const o of out.slice(0, stored)) state.rows[o.k] = o.h;
                pushed += stored;
                unsaved += out.length - stored;
            }
            const key = `${file.cropYear}|${file.month}`;
            const finished = !truncated && !(limitReached && unsaved > 0);
            if (opts.onlyNew) {
                if (finished) delete state.pending[key];
                else state.pending[key] = { cropYear: file.cropYear, month: file.month, url: file.url, preliminary: file.preliminary };
                if (out.length || !finished || !state.pending[key]) await saveState();
            }
            processedFiles.push({ month: file.month, cropYear: file.cropYear, url: file.url, finished });
            if (truncated || limitReached) break;
        }
        // Files not reached in this run stay pending for the next one.
        if (opts.onlyNew) {
            for (const { file } of parsed.slice(processedFiles.length)) state.pending[`${file.cropYear}|${file.month}`] = { cropYear: file.cropYear, month: file.month, url: file.url, preliminary: file.preliminary };
            if (parsed.length > processedFiles.length || state.legacy) await saveState();
        }
        const filesLeft = parsed.length - processedFiles.length;
        if (pendingUnavailable.length) log.warning(`${pendingUnavailable.length} unfinished month(s) from an earlier run can no longer be downloaded: ${pendingUnavailable.map((f) => f.month).join(', ')}.`);
        const stopReason = unsaved > 0 || (limitReached && filesLeft > 0) ? 'spendingLimit' : truncated ? 'maxItems' : null;
        if (stopReason === 'spendingLimit') log.warning(`Spending limit reached: ${unsaved} row(s) and ${filesLeft} file(s) were not saved${opts.onlyNew ? ' and will be returned by the next run' : ''}.`);
        else if (truncated) log.warning(`Stopped at maxItems (${opts.maxItems})${opts.onlyNew ? '; the rest will be returned by the next run' : ''}.`);
        else if (limitReached) log.info('All rows were saved; your spending limit has now been reached.');
        await actor.setValue('RUN_SUMMARY', {
            months: [...wanted], selectedFiles: selected.length, processedFiles,
            availableMonths: available, monthsShortfall: shortfall, pendingUnavailable: pendingUnavailable.map((f) => f.month), pushed,
            incomplete: stopReason !== null || shortfall > 0 || pendingUnavailable.length > 0,
            stopReason, spendingLimitReached: limitReached,
        });
        await releaseLock();
        log.info(`Done. Pushed ${pushed} rows from ${processedFiles.length} of ${selected.length} MAFF file(s).`);
        await actor.exit();
    } catch (err) {
        const msg = sanitize(err.message);
        log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
        await releaseLock().catch(() => {});
        await actor.fail(msg);
    }
}
