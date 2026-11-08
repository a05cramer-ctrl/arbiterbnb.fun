// /api/tick — the keeper. Vercel Cron (Bearer CRON_SECRET) or ?key=CRON_SECRET. ?dry=1 simulates everything, sends nothing.
//   0. unwrap WBNB tax if any arrived as WBNB (anyone may call vault.unwrap())
//   1. close every open position whose exitReason(pid) != ""          (one tx each)
//   2. if the oracle callback is UNDELIVERED, provider.retryUndelivered(requestId) (callable by anyone)
//   3. if not paused, nothing pending, an hour since the last ask, < 3 open, nextTradeSize() > 0:
//      compute the ten (public rule) and call vault.ask(ten)
import { createHash, timingSafeEqual } from 'node:crypto';
import { Contract, Wallet, ZeroAddress, parseUnits } from 'ethers';
import { addresses, getProvider, vaultContract, providerContract, decodeRevert, REQUEST_STATUS } from './_lib/chain.js';
import { computeCandidates } from './_lib/candidates.js';
import { send, query, shortErr } from './_lib/util.js';

const MIN_INTERVAL = 3600, MAX_OPEN = 3, MAX_SCAN = 500;
const TIME_BUDGET_MS = 45_000; // Vercel maxDuration is 60s; don't start an ask after this

const h = s => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(h(a), h(b));

export function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  const key = query(req).key || '';
  return same(auth, `Bearer ${secret}`) || (key !== '' && same(key, secret));
}

function txOverrides() {
  const g = process.env.GAS_PRICE_GWEI;
  return g ? { gasPrice: parseUnits(g, 'gwei'), type: 0 } : {};
}

/** staticCall -> (dry ? stop : estimateGas*1.3 -> send -> receipt). Never throws. */
async function exec(log, label, contract, method, args, dry) {
  const step = { step: label };
  log.steps.push(step);
  try {
    await contract[method].staticCall(...args, txOverrides());
  } catch (e) {
    step.ok = false; step.error = decodeRevert(e); return step;
  }
  if (dry) { step.ok = true; step.dry = true; return step; }
  try {
    const est = await contract[method].estimateGas(...args, txOverrides());
    const gasLimit = (est * 130n) / 100n;
    const tx = await contract[method](...args, { ...txOverrides(), gasLimit });
    step.hash = tx.hash;
    const rc = await tx.wait(1, 40_000);
    step.ok = rc?.status === 1;
    step.gasUsed = rc ? rc.gasUsed.toString() : null;
    step.block = rc?.blockNumber ?? null;
    Object.defineProperty(step, 'receipt', { value: rc, enumerable: false }); // kept out of the JSON log
  } catch (e) {
    step.ok = false; step.error = decodeRevert(e);
  }
  return step;
}

export async function runTick({ dry = false } = {}) {
  const t0 = Date.now();
  const a = addresses();
  const log = { ok: true, dry, steps: [], skipped: null };
  if (!a.vault) return { ...log, ok: false, skipped: 'VAULT_ADDRESS not set' };
  if (!process.env.KEEPER_PK) return { ...log, ok: false, skipped: 'KEEPER_PK not set' };

  const p = getProvider();
  const wallet = new Wallet(process.env.KEEPER_PK, p);
  const v = vaultContract(wallet);
  log.keeper = wallet.address;

  const [head, keeper, owner, bal] = await Promise.all([p.getBlock('latest'), v.keeper(), v.owner(), p.getBalance(wallet.address)]);
  log.at = Number(head.timestamp);
  log.block = head.number;
  log.keeperBalanceBnb = (Number(bal) / 1e18).toFixed(5);
  if (wallet.address !== keeper && wallet.address !== owner) log.warning = `KEEPER_PK (${wallet.address}) is neither vault.keeper (${keeper}) nor owner; ask() will revert NotKeeper`;

  // 0. WBNB -> BNB
  try {
    const wbnb = await v.wbnb();
    if (wbnb && wbnb !== ZeroAddress) {
      const w = new Contract(wbnb, ['function balanceOf(address) view returns (uint256)'], p);
      const wb = await w.balanceOf(a.vault);
      if (wb > 0n) await exec(log, `unwrap ${wb} wei WBNB`, v, 'unwrap', [], dry);
    }
  } catch (e) { log.steps.push({ step: 'unwrap check', ok: false, error: shortErr(e) }); }

  // 1. exits
  let open = Number(await v.openPositions());
  const nP = Number(await v.positionsCount());
  let found = 0, closed = 0;
  for (let i = nP - 1; i >= 0 && found < open && nP - 1 - i < MAX_SCAN; i--) {
    const pos = await v.getPosition(i);
    if (!pos.open) continue;
    found++;
    let why = '';
    try { why = await v.exitReason(i); } catch (e) { log.steps.push({ step: `exitReason(${i})`, ok: false, error: decodeRevert(e) }); continue; }
    if (!why) continue;
    const s = await exec(log, `close(${i}) ${why}`, v, 'close', [i], dry);
    if (s.receipt) {
      const ev = s.receipt.logs.map(l => { try { return v.interface.parseLog(l); } catch { return null; } }).find(x => x?.name === 'Closed');
      if (ev) s.closed = { position: Number(ev.args.position), why: ev.args.why, bnbOut: ev.args.bnbOut.toString(), pnl: ev.args.pnl.toString() };
    }
    if (s.ok && !dry) closed++;
  }
  if (found < open) log.steps.push({ step: 'scan', ok: false, error: `found ${found}/${open} open positions in the last ${MAX_SCAN}` });

  // 2. pending request: retry an UNDELIVERED callback
  const [pendingId] = await v.pending();
  const prov = providerContract(wallet, await v.provider().catch(() => a.aiProvider));
  if (pendingId !== 0n) {
    let status = null;
    try { status = REQUEST_STATUS[Number((await prov.getRequest(pendingId)).status)]; } catch (e) { log.steps.push({ step: 'getRequest', ok: false, error: decodeRevert(e) }); }
    log.pending = { requestId: pendingId.toString(), status };
    if (status === 'UNDELIVERED') {
      await exec(log, `retryUndelivered(${pendingId})`, prov, 'retryUndelivered', [pendingId], dry);
    }
    if (dry) {
      return { ...log, skipped: `request ${pendingId} pending (${status ?? 'unknown'})`, ms: Date.now() - t0 };
    }
    // a successful retry delivered the pick and cleared it; re-read
    if ((await v.pending())[0] !== 0n) return { ...log, skipped: `request ${pendingId} pending (${status ?? 'unknown'})`, ms: Date.now() - t0 };
  }

  // 3. ask
  const [paused, lastAskedAt, openNow, size] = await Promise.all([v.paused(), v.lastAskedAt(), v.openPositions(), v.nextTradeSize()]);
  open = Number(openNow);
  const now = Number(head.timestamp);
  const nextAt = Number(lastAskedAt) + MIN_INTERVAL;
  // a dry run pretends the closes it simulated went through
  const openAfter = dry ? open - log.steps.filter(s => s.dry && s.step.startsWith('close(')).length : open;
  log.state = { paused, lastAskedAt: Number(lastAskedAt), nextAskAt: nextAt, open, nextTradeSizeWei: size.toString(), closed };
  if (paused) return { ...log, skipped: 'paused', ms: Date.now() - t0 };
  if (now < nextAt) return { ...log, skipped: `too soon: next ask at ${nextAt} (in ${nextAt - now}s)`, ms: Date.now() - t0 };
  if (openAfter >= MAX_OPEN) return { ...log, skipped: `${openAfter} open positions (max ${MAX_OPEN})`, ms: Date.now() - t0 };
  if (size === 0n) return { ...log, skipped: 'nextTradeSize() == 0 (bankroll too small)', ms: Date.now() - t0 };

  let c;
  try { c = await computeCandidates({ provider: p, withMeta: false }); }
  catch (e) { return { ...log, ok: false, skipped: 'candidates failed: ' + shortErr(e), ms: Date.now() - t0 }; }
  log.candidates = { from: c.from, to: c.to, blocks: c.blocks, scan: c.scan, errors: c.errors,
    list: c.list.map(x => ({ address: x.address, bnbVolume1h: x.bnbVolume1h, trades: x.trades, progress: x.progress })) };
  if (c.list.length < 10) return { ...log, skipped: `only ${c.list.length} coins match the rule`, ms: Date.now() - t0 };
  if (Date.now() - t0 > TIME_BUDGET_MS) return { ...log, skipped: 'out of time budget before ask; next tick will retry', ms: Date.now() - t0 };

  if (dry) {
    try { log.oracle = { maxPromptLength: (await prov.maxPromptLength()).toString(), callbackGasLimit: (await prov.callbackGasLimit()).toString() }; }
    catch (e) { log.oracle = { error: decodeRevert(e) }; }
  }
  const ten = c.list.map(x => x.address);
  const s = await exec(log, 'ask', v, 'ask', [ten], dry);
  if (s.receipt) {
    const ev = s.receipt.logs.map(l => { try { return v.interface.parseLog(l); } catch { return null; } }).find(x => x?.name === 'Asked');
    if (ev) s.asked = { round: Number(ev.args.round), requestId: ev.args.requestId.toString(), fee: ev.args.fee.toString(), size: ev.args.size.toString() };
  }
  log.ok = log.steps.every(x => x.ok !== false);
  return { ...log, ms: Date.now() - t0 };
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) return send(res, 500, { ok: false, error: 'CRON_SECRET not set' });
  if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
  const q = query(req);
  const dry = q.dry === '1' || q.dry === 'true';
  try {
    const out = await runTick({ dry });
    send(res, 200, out, { 'Cache-Control': 'no-store' });
  } catch (e) {
    send(res, 500, { ok: false, error: decodeRevert(e) }, { 'Cache-Control': 'no-store' });
  }
}
