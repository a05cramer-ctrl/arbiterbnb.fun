// THE PUBLIC RULE for the ten coins ARBITER chooses from.
//
//   The 10 Flap coins still on their bonding curve with the most BNB traded in the last 60 minutes,
//   quoted in BNB, curve progress < 90%, excluding $ARBITER and coins the vault already holds;
//   ties broken by address.
//
// Precise definition (this file is the reference implementation; scripts/verify-candidates.mjs reuses it):
//   window   = [M - 3600, M) in block-timestamp seconds, M = the start of the minute (floor(t/60)*60) of
//              the chain head when the list is computed. Blocks: first block with ts >= M-3600 .. last
//              block with ts < M.
//   volume   = sum of `eth` over every Portal TokenBought + TokenSold event in that block range, per token.
//   filters  = Portal.getTokenV8(token): status == Tradable (1), quoteTokenAddress == 0x0 (BNB),
//              progress < 0.9e18; token != $ARBITER; vault.holding(token) == false. (Also: the enum fields
//              must be in the range the vault's ABI can decode, otherwise vault.ask() would revert.)
//   order    = volume desc, then address asc (lower-case hex); take the first 10 that pass the filters.
import { Contract, ZeroAddress, formatEther, getAddress, Interface } from 'ethers';
import { PORTAL_ABI, PORTAL_EVENTS_INDEXED, getProvider, addresses, portalContract, erc20, getArbiterToken, VAULT_ABI } from './chain.js';
import { mapLimit, sanitize, shortErr, envInt } from './util.js';

export const RULE =
  'The 10 Flap coins still on their bonding curve with the most BNB traded in the last 60 minutes, quoted in BNB, ' +
  'curve progress < 90%, excluding $ARBITER and coins the vault already holds; ties broken by address.';
export const WINDOW_SECONDS = 3600;
export const NUM = 10;
export const GRAD_EXIT = 900000000000000000n; // 0.9e18, same constant as the vault

const IFACE = new Interface(PORTAL_ABI);
const IFACE_IDX = new Interface(PORTAL_EVENTS_INDEXED);
export function tradeTopics() {
  return {
    bought: process.env.TOPIC_BOUGHT || IFACE.getEvent('TokenBought').topicHash,
    sold: process.env.TOPIC_SOLD || IFACE.getEvent('TokenSold').topicHash,
  };
}

// ------------------------------------------------------------------ blocks <-> timestamps

/** Returns a cached block-timestamp reader. */
export function blockClock(provider) {
  const cache = new Map();
  let calls = 0;
  const ts = async n => {
    if (cache.has(n)) return cache.get(n);
    calls++;
    const b = await provider.getBlock(n);
    if (!b) throw new Error(`block ${n} not found`);
    cache.set(n, Number(b.timestamp));
    return Number(b.timestamp);
  };
  return { ts, calls: () => calls };
}

/**
 * First block whose timestamp is >= target. Many BSC blocks share one second (sub-second blocks),
 * so this is the boundary between "< target" and ">= target". head = {number, timestamp}.
 * Interpolation search alternated with bisection (guaranteed O(log n) on uneven block times).
 */
export async function firstBlockAtOrAfter(clock, target, head, loHint = 0) {
  if (head.timestamp < target) return head.number + 1;
  let hi = head.number, hiT = head.timestamp;
  const hint = Number(process.env.BLOCK_TIME_HINT || 0.45); // seconds per block (BSC ~0.45s after Fermi)
  let span = Math.ceil((hiT - target) / hint) + 64;
  let lo = Math.max(loHint, hi - span), loT = await clock.ts(lo);
  while (loT >= target) {
    if (lo <= loHint) return lo; // everything from the hint on is >= target
    hi = lo; hiT = loT; span *= 4;
    lo = Math.max(loHint, hi - span); loT = await clock.ts(lo);
  }
  let i = 0;
  while (hi - lo > 1) {
    let mid = (i++ % 2 === 0 && hiT > loT)
      ? lo + Math.floor(((target - loT) * (hi - lo)) / (hiT - loT))
      : lo + Math.floor((hi - lo) / 2);
    mid = Math.min(hi - 1, Math.max(lo + 1, mid));
    const t = await clock.ts(mid);
    if (t < target) { lo = mid; loT = t; } else { hi = mid; hiT = t; }
  }
  return hi;
}

/** Block range [fromBlock, toBlock] covering timestamps [fromTs, toTs). */
export async function blockRange(provider, fromTs, toTs, head) {
  const clock = blockClock(provider);
  if (!head) { const b = await provider.getBlock('latest'); head = { number: b.number, timestamp: Number(b.timestamp) }; }
  const fromBlock = await firstBlockAtOrAfter(clock, fromTs, head);
  const toBlock = (await firstBlockAtOrAfter(clock, toTs, head, Math.max(0, fromBlock - 1))) - 1;
  return { fromBlock, toBlock, head, blockReads: clock.calls() };
}

// ------------------------------------------------------------------ logs

/**
 * eth_getLogs for TokenBought|TokenSold over [fromBlock, toBlock], in chunks of LOGS_CHUNK blocks with
 * LOGS_CONCURRENCY in flight. A failing chunk is split in half (RPC range/result limits) down to 1 block.
 */
export async function fetchTradeLogs(provider, portal, fromBlock, toBlock, opts = {}) {
  const chunk = opts.chunk || envInt('LOGS_CHUNK', 2500);
  const conc = opts.concurrency || envInt('LOGS_CONCURRENCY', 4);
  const { bought, sold } = tradeTopics();
  const stats = { calls: 0, splits: 0, retries: 0 };
  const ranges = [];
  for (let a = fromBlock; a <= toBlock; a += chunk) ranges.push([a, Math.min(toBlock, a + chunk - 1)]);

  // Budget so an RPC that rejects getLogs outright fails fast instead of splitting into thousands of calls.
  const budget = ranges.length * 16 + 32;
  const get = async (a, b, tries = 0) => {
    if (stats.calls >= budget) throw new Error(`getLogs gave up after ${stats.calls} calls (RPC rejects getLogs? set BSC_RPC to a getLogs-capable node or lower LOGS_CHUNK)`);
    try {
      stats.calls++;
      return await provider.getLogs({ address: portal, topics: [[bought, sold]], fromBlock: a, toBlock: b });
    } catch (e) {
      if (String(e?.message || '').startsWith('getLogs gave up')) throw e;
      if (b > a) { // range / result-size limit: split in half
        stats.splits++;
        const m = a + Math.floor((b - a) / 2);
        const x = await get(a, m);
        const y = await get(m + 1, b);
        return x.concat(y);
      }
      if (tries < 2) { // single block: maybe transient
        stats.retries++;
        await new Promise(r => setTimeout(r, 300 * (tries + 1)));
        return get(a, b, tries + 1);
      }
      throw new Error(`getLogs ${a}-${b} failed: ${shortErr(e)}`);
    }
  };
  const parts = await mapLimit(ranges, conc, ([a, b]) => get(a, b));
  return { logs: parts.flat(), stats, ranges: ranges.length };
}

/** Decode one trade log -> {token, eth} or null. Tries the documented (all non-indexed) layout first. */
export function decodeTrade(log) {
  for (const iface of log.topics.length > 1 ? [IFACE_IDX, IFACE] : [IFACE, IFACE_IDX]) {
    try {
      const p = iface.parseLog({ topics: log.topics, data: log.data });
      if (!p || (p.name !== 'TokenBought' && p.name !== 'TokenSold')) continue;
      return { token: getAddress(p.args.token), eth: p.args.eth, side: p.name === 'TokenBought' ? 'buy' : 'sell' };
    } catch {}
  }
  // topic0 overridden by env to an unknown signature: assume the documented field order in data.
  try {
    const [ts, token, trader, amount, eth] = IFACE.getAbiCoder().decode(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'], log.data);
    void ts; void trader; void amount;
    return { token: getAddress(token), eth, side: '?' };
  } catch { return null; }
}

/** Sum BNB volume + trade count per token. */
export function aggregate(logs) {
  const by = new Map();
  let bad = 0;
  for (const l of logs) {
    const t = decodeTrade(l);
    if (!t) { bad++; continue; }
    const k = t.token.toLowerCase();
    const e = by.get(k) || { address: t.token, eth: 0n, trades: 0 };
    e.eth += t.eth; e.trades++;
    by.set(k, e);
  }
  return { by, bad };
}

export function rankByVolume(by) {
  return [...by.values()].filter(e => e.eth > 0n).sort((a, b) =>
    a.eth === b.eth ? (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1) : (a.eth > b.eth ? -1 : 1));
}

// ------------------------------------------------------------------ metadata (display only)

const _meta = new Map();
const CID_RE = /^[A-Za-z0-9]{20,100}(\/[A-Za-z0-9._-]{1,80})?$/;
function gateway() { return (process.env.IPFS_GATEWAY || 'https://flap.mypinata.cloud/ipfs/').replace(/\/?$/, '/'); }
function cidOf(s) {
  if (typeof s !== 'string') return null;
  let v = s.trim().replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '');
  const m = v.match(/\/ipfs\/([^?#]+)/); if (m) v = m[1];
  return CID_RE.test(v) ? v : null;
}

export async function tokenMeta(address, { withImage = true, provider } = {}) {
  const k = address.toLowerCase() + (withImage ? ':i' : '');
  if (_meta.has(k)) return _meta.get(k);
  const c = erc20(address, provider);
  const [name, symbol, metaURI] = await Promise.all([
    c.name().catch(() => null), c.symbol().catch(() => null), withImage ? c.metaURI().catch(() => null) : null,
  ]);
  const out = { name: sanitize(name), symbol: sanitize(symbol), meta: cidOf(metaURI), image: null };
  if (withImage && out.meta) {
    try {
      const r = await fetch(gateway() + out.meta, { signal: AbortSignal.timeout(envInt('META_TIMEOUT_MS', 2500)) });
      if (r.ok) {
        const j = await r.json();
        const img = cidOf(j?.image);
        if (img) out.image = gateway() + img;
        else if (typeof j?.image === 'string' && /^https:\/\/[^\s"'<>]{1,300}$/.test(j.image)) out.image = j.image;
      }
    } catch {}
  }
  if (_meta.size > 3000) _meta.clear();
  // don't cache a missing image for long-lived lambdas: only cache full results or no-meta tokens
  if (!withImage || out.image || !out.meta) _meta.set(k, out);
  return out;
}

// ------------------------------------------------------------------ the rule

/**
 * Compute the ten.
 * opts: { provider, portal, vault, arbiter, toTs, blockTag, withMeta, chunk, concurrency, maxCheck }
 *   toTs     window end (exclusive). Default: start of the current minute of the chain head.
 *   blockTag state reads (getTokenV8 / holding) at this block — 'latest' live; an older block to verify a round.
 */
export async function computeCandidates(opts = {}) {
  const t0 = Date.now();
  const provider = opts.provider || getProvider();
  const a = addresses();
  const portalAddr = opts.portal || a.portal;
  const vaultAddr = opts.vault !== undefined ? opts.vault : a.vault;
  const blockTag = opts.blockTag ?? 'latest';
  const errors = [];

  const hb = await provider.getBlock('latest');
  const head = { number: hb.number, timestamp: Number(hb.timestamp) };
  const toTs = opts.toTs ?? Math.floor(head.timestamp / 60) * 60;
  const fromTs = toTs - WINDOW_SECONDS;
  const range = await blockRange(provider, fromTs, toTs, head);

  const { logs, stats } = range.toBlock >= range.fromBlock
    ? await fetchTradeLogs(provider, portalAddr, range.fromBlock, range.toBlock, opts)
    : { logs: [], stats: { calls: 0 } };
  const { by, bad } = aggregate(logs);
  if (bad) errors.push(`${bad} trade logs could not be decoded`);

  const vault = vaultAddr ? new Contract(vaultAddr, VAULT_ABI, provider) : null;
  let arbiter = opts.arbiter !== undefined ? opts.arbiter : null;
  if (opts.arbiter === undefined && vault) arbiter = await getArbiterToken(vault, blockTag).catch(e => { errors.push('arbiterToken: ' + shortErr(e)); return null; });
  if (opts.arbiter === undefined && !vault) arbiter = a.arbiterToken;
  const arbLc = arbiter ? arbiter.toLowerCase() : null;

  const ranked = rankByVolume(by).filter(e => e.address.toLowerCase() !== arbLc);
  const portal = portalContract(provider, portalAddr);
  const maxCheck = opts.maxCheck || envInt('CANDIDATE_MAX_CHECK', 400);
  const batch = 25;
  const picked = [];
  const rejected = {};
  let checked = 0;

  for (let i = 0; i < ranked.length && picked.length < NUM && checked < maxCheck; i += batch) {
    const slice = ranked.slice(i, i + batch);
    checked += slice.length;
    const res = await mapLimit(slice, opts.concurrency || envInt('RPC_CONCURRENCY', 8), async e => {
      let s;
      try { s = await portal.getTokenV8Safe(e.address, { blockTag }); } catch { try { s = await portal.getTokenV8(e.address, { blockTag }); } catch {} }
      if (!s) return { e, why: 'getTokenV8 failed' };
      if (Number(s.status) !== 1) return { e, why: 'not on curve' };
      if (s.quoteTokenAddress !== ZeroAddress) return { e, why: 'not BNB-quoted' };
      if (s.progress >= GRAD_EXIT) return { e, why: 'progress >= 90%' };
      if (Number(s.tokenVersion) > 7 || Number(s.lpFeeProfile) > 2 || Number(s.dexId) > 2) return { e, why: 'state not decodable by vault' };
      if (vault) {
        let held;
        try { held = await vault.holding(e.address, { blockTag }); }
        catch (err) { return { e, why: 'holding() failed' }; }
        if (held) return { e, why: 'held by vault' };
      }
      return { e, ok: true, progress: s.progress };
    });
    for (const r of res) {
      if (r.ok) { if (picked.length < NUM) picked.push({ ...r.e, progress: r.progress }); }
      else rejected[r.why] = (rejected[r.why] || 0) + 1;
    }
  }

  const metas = opts.withMeta === false ? picked.map(() => null)
    : await mapLimit(picked, 5, p => tokenMeta(p.address, { withImage: opts.withImage !== false, provider }).catch(() => null));

  const list = picked.map((p, i) => ({
    rank: i + 1,
    address: p.address,
    bnbVolume1h: formatEther(p.eth),
    trades: p.trades,
    progress: Math.round(Number(p.progress) / 1e14) / 1e4, // 0..1, 4 decimals
    name: metas[i]?.name ?? null,
    symbol: metas[i]?.symbol ?? null,
    meta: metas[i]?.meta ?? null,
    image: metas[i]?.image ?? null,
  }));

  return {
    at: head.timestamp,
    rule: RULE,
    window: '60m',
    from: fromTs,
    to: toTs,
    blocks: { from: range.fromBlock, to: range.toBlock, head: head.number },
    list,
    scan: { tokensTraded: by.size, trades: logs.length, checked, rejected, getLogsCalls: stats.calls, ms: Date.now() - t0 },
    arbiter,
    errors,
  };
}
