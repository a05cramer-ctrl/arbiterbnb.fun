// GET /api/stats -> everything the site shows, read straight from the vault.
// Never 500s for one bad read: each field is read with its own try/catch; failures land in `errors`.
import { ZeroAddress } from 'ethers';
import { addresses, getProvider, vaultContract, providerContract, REQUEST_STATUS } from './_lib/chain.js';
import { tokenMeta } from './_lib/candidates.js';
import { mapLimit, safe, send, CORS, bnb, num, str, envInt } from './_lib/util.js';

const LAST = 48;
const IPFS = cid => (cid ? `https://ipfs.io/ipfs/${cid}` : null);
const CID_OK = /^[A-Za-z0-9]{20,100}$/;

function pnlPct(cost, out) {
  if (out == null || !cost) return null;
  return Number(((out - cost) * 10000n) / cost) / 100; // 2 decimals
}

export async function readStats() {
  const a = addresses();
  if (!a.vault) return { live: false, reason: 'VAULT_ADDRESS not set' };
  const p = getProvider();
  const v = vaultContract(p);
  const errors = [];
  const conc = envInt('RPC_CONCURRENCY', 8);
  const S = (label, fn, fb = null) => safe(fn, fb, errors, label);

  // ---- scalar reads
  const keys = {
    head: () => p.getBlock('latest'),
    token: () => v.arbiterToken(), provider: () => v.provider(), modelId: () => v.modelId(),
    questionFee: () => v.questionFee(), bankroll: () => v.bankroll(), nextTradeSize: () => v.nextTradeSize(),
    paused: () => v.paused(), burnOnProfit: () => v.burnOnProfit(), lastAskedAt: () => v.lastAskedAt(),
    pending: () => v.pending(), rounds: () => v.roundsCount(), positions: () => v.positionsCount(), open: () => v.openPositions(),
    taxIn: async () => (await v.totalTaxIn()) + (await v.pendingTax().catch(() => 0n)), oracleFees: () => v.totalOracleFees(), bought: () => v.totalBoughtBnb(), sold: () => v.totalSoldBnb(),
    burnedBnb: () => v.totalBurnedBnb(), burnedTokens: () => v.totalBurnedTokens(),
    maxTrade: () => v.maxTrade(), minTrade: () => v.minTrade(), withdrawUnlockAt: () => v.withdrawUnlockAt(),
    owner: () => v.owner(), keeper: () => v.keeper(),
  };
  const names = Object.keys(keys);
  const vals = await mapLimit(names, conc, k => S(k, keys[k]));
  const r = Object.fromEntries(names.map((k, i) => [k, vals[i]]));

  const providerAddr = r.provider || a.aiProvider;
  const prov = providerContract(p, providerAddr);
  const model = r.modelId != null ? await S('getModel', () => prov.getModel(r.modelId)) : null;

  const reqInfo = async rid => {
    if (!rid) return { cid: null, status: null };
    const q = await S(`getRequest(${rid})`, () => prov.getRequest(rid));
    let cid = q?.reasoningCid || null;
    if (!q) cid = await safe(() => prov.getReasoningCid(rid), null); // integration-guide name; not in the published interface
    return { cid: cid && CID_OK.test(cid) ? cid : null, status: q ? REQUEST_STATUS[Number(q.status)] ?? String(q.status) : null };
  };
  const meta = async t => (t && t !== ZeroAddress ? await safe(() => tokenMeta(t, { withImage: false, provider: p }), null) : null);

  // ---- rounds (newest first)
  const nR = r.rounds != null ? Number(r.rounds) : 0;
  const rIdx = Array.from({ length: Math.min(LAST, nR) }, (_, k) => nR - 1 - k);
  const rounds = (await mapLimit(rIdx, conc, async i => {
    const x = await S(`getRound(${i})`, () => v.getRound(i));
    if (!x) return { i, error: true };
    const choice = Number(x.choice);
    const candidates = [...x.candidates].map(String);
    const pickAddr = choice < 10 ? candidates[choice] : null;
    const [info, m] = await Promise.all([reqInfo(x.requestId), meta(pickAddr)]);
    return {
      i,
      askedAt: num(x.askedAt),
      answeredAt: num(x.answeredAt) || null,
      choice: choice === 255 ? null : choice,
      bought: x.bought,
      requestId: str(x.requestId),
      status: info.status,
      fee: bnb(x.fee),
      size: bnb(x.size),
      candidates,
      pick: pickAddr ? { address: pickAddr, symbol: m?.symbol ?? null, name: m?.name ?? null } : null,
      cid: info.cid,
      proofUrl: IPFS(info.cid),
    };
  }));

  // ---- positions (newest first)
  const nP = r.positions != null ? Number(r.positions) : 0;
  const pIdx = Array.from({ length: Math.min(LAST, nP) }, (_, k) => nP - 1 - k);
  const positions = (await mapLimit(pIdx, conc, async i => {
    const x = await S(`getPosition(${i})`, () => v.getPosition(i));
    if (!x) return { i, error: true };
    const [m, val, exit] = await Promise.all([
      meta(x.token),
      x.open ? S(`positionValue(${i})`, () => v.positionValue(i)) : null,
      x.open ? S(`exitReason(${i})`, () => v.exitReason(i)) : null,
    ]);
    const valueNow = val ? val[0] : null;
    return {
      i,
      round: num(x.round),
      token: x.token,
      symbol: m?.symbol ?? null,
      name: m?.name ?? null,
      amount: bnb(x.amount), // token units (18 decimals)
      cost: bnb(x.cost),
      proceeds: x.open ? null : bnb(x.proceeds),
      open: x.open,
      openedAt: num(x.openedAt),
      closedAt: num(x.closedAt) || null,
      valueNow: x.open ? bnb(valueNow) : null,
      onCurve: x.open && val ? val[1] : null,
      progress: x.open && val ? Math.round(Number(val[2]) / 1e14) / 1e4 : null,
      exitReason: x.open ? (exit || '') : null,
      pnlPct: x.open ? pnlPct(x.cost, valueNow) : pnlPct(x.cost, x.proceeds),
    };
  }));

  // pending request + its oracle status
  const pendingId = r.pending ? r.pending[0] : null;
  const pendingInfo = pendingId ? await reqInfo(pendingId) : null;
  const last = r.lastAskedAt != null ? Number(r.lastAskedAt) : null;

  return {
    live: true,
    at: r.head ? Number(r.head.timestamp) : Math.floor(Date.now() / 1000),
    block: r.head ? r.head.number : null,
    vault: a.vault,
    token: r.token && r.token !== ZeroAddress ? r.token : null,
    provider: providerAddr,
    modelId: num(r.modelId),
    modelName: model ? model.name : null,
    questionFeeBnb: bnb(r.questionFee ?? model?.price ?? null),
    bankrollBnb: bnb(r.bankroll),
    nextTradeSizeBnb: bnb(r.nextTradeSize),
    minTradeBnb: bnb(r.minTrade),
    maxTradeBnb: bnb(r.maxTrade),
    paused: r.paused,
    burnOnProfit: r.burnOnProfit,
    lastAskedAt: last,
    nextAskAt: last ? last + 3600 : null, // keeper ticks every 5 min, so the ask lands at the first tick after this
    pending: {
      requestId: pendingId ? str(pendingId) : null,
      round: pendingId ? num(r.pending[1]) : null,
      status: pendingInfo?.status ?? null,
    },
    counts: { rounds: r.rounds != null ? nR : null, positions: r.positions != null ? nP : null, open: num(r.open) },
    totals: {
      taxInBnb: bnb(r.taxIn), oracleFeesBnb: bnb(r.oracleFees), boughtBnb: bnb(r.bought), soldBnb: bnb(r.sold),
      burnedBnb: bnb(r.burnedBnb), burnedTokens: bnb(r.burnedTokens),
    },
    withdrawUnlockAt: r.withdrawUnlockAt != null ? Number(r.withdrawUnlockAt) || null : null,
    owner: r.owner, keeper: r.keeper,
    rounds,
    positions,
    errors,
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v); res.statusCode = 204; return res.end(); }
  let body;
  try { body = await readStats(); }
  catch (e) { body = { live: true, errors: [String(e?.shortMessage || e?.message || e)] }; }
  send(res, 200, body, { ...CORS, 'Cache-Control': 's-maxage=20, stale-while-revalidate=60' });
}
