// Ganache test for api/_lib/candidates.js: ranking, filtering, window edges, chunked + split getLogs,
// indexed-event fallback, metadata/image resolution.  Run: node scripts/test-candidates.mjs
import ganache from 'ganache';
import http from 'node:http';
import { ethers } from 'ethers';
import { compile, deploy, ok, eq, done, ganacheAccounts } from './_testkit.mjs';

const BASE = 1_900_000_000;           // window end used in the test (exclusive)
const FROM = BASE - 3600;
const E = ethers.parseEther;

// --- local "IPFS gateway" so image resolution is tested without internet
const META_CID = 'bafkreieepx7lh6zcpqsneo2jdeqmcgxjg7facam34w5ezh4myajjauuc24';
const IMG_CID = 'bafkreibwjuzzns6yf4wytfr5nk6vujb4yja4iejff2k76nshn2z5jkmiy4';
const gw = http.createServer((req, res) => {
  if (req.url === '/ipfs/' + META_CID) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ image: IMG_CID, description: 'x' })); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise(r => gw.listen(0, '127.0.0.1', r));
process.env.IPFS_GATEWAY = `http://127.0.0.1:${gw.address().port}/ipfs/`;
process.env.CHAIN_ID = '1337';

const C = await import('../api/_lib/candidates.js');

const g = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337, time: new Date((BASE - 20000) * 1000) },
  wallet: { accounts: ganacheAccounts() },
  miner: { instamine: 'eager' },
});

// EIP-1193 wrapper: count getLogs, optionally reject ranges wider than `limit` blocks (like public RPCs do)
const rpc = { getLogs: 0, rejected: 0, limit: Infinity };
const wrapped = {
  request: async (a) => {
    if (a.method === 'eth_getLogs') {
      rpc.getLogs++;
      const f = a.params[0];
      const span = Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) + 1;
      if (span > rpc.limit) { rpc.rejected++; const e = new Error('query returned more than 10000 results / block range too large'); e.code = -32005; throw e; }
    }
    return g.request(a);
  },
};
const provider = new ethers.BrowserProvider(wrapped, 1337, { polling: false, cacheTimeout: -1 });
const signer = await provider.getSigner(0);
const T = compile();

console.log('deploy');
const portal = await deploy(signer, T.TPortal);
const portalIdx = await deploy(signer, T.TPortalIndexed, await portal.getAddress());
const vaultView = await deploy(signer, T.TVaultView);
const P = await portal.getAddress(), PI = await portalIdx.getAddress(), VV = await vaultView.getAddress();

const tok = async (name, sym, meta = '') => (await deploy(signer, T.TToken, name, sym, meta)).getAddress();
const valid = [];
for (let i = 0; i < 12; i++) valid.push(await tok(i === 2 ? 'Evil\u202Ename\u0007 that is way too long for the card' : `Coin ${i}`, i === 2 ? 'EV\u0000IL' : `C${i}`, i === 0 ? META_CID : ''));
const grad = await tok('Grad', 'GRAD'), dex = await tok('Dex', 'DEX'), arb = await tok('ARBITER', 'ARBITER');
const held = await tok('Held', 'HELD'), old = await tok('Old', 'OLD'), edge = await tok('Edge', 'EDGE'), v9 = await tok('V9', 'V9');
const usd = Array.from({ length: 30 }, () => ethers.Wallet.createRandom().address); // USD-quoted, huge "eth" numbers
const someQuote = ethers.Wallet.createRandom().address;

const tx = async p => (await p).wait();
for (const a of [...valid, held, old, edge, arb]) await tx(portal.set(a, 1, ethers.ZeroAddress, E('0.3'), 1));
await tx(portal.set(grad, 1, ethers.ZeroAddress, E('0.95'), 1));
await tx(portal.set(dex, 4, ethers.ZeroAddress, E('1'), 1));
await tx(portal.set(v9, 1, ethers.ZeroAddress, E('0.1'), 1)); await tx(portal.setVersion(v9, 9));
for (const u of usd) await tx(portal.set(u, 1, someQuote, E('0.2'), 1));
await tx(portal.setProgress(valid[3], E('0.8999')));
await tx(vaultView.setHolding(held, true));
await tx(vaultView.setArbiterToken(arb));

// --- volumes inside the window (BNB). valid[i] = 20 - i, with a tie: valid[6] == valid[5] == 15
const want = new Map(valid.map((a, i) => [a, E(String(20 - i))]));
want.set(valid[6], E('15'));
const inWindow = [];
for (const [a, v] of want) { const q = v / 4n; inWindow.push([a, true, q], [a, false, q], [a, true, q], [a, true, v - 3n * q]); }
inWindow.push([grad, true, E('500')], [dex, true, E('400')], [arb, true, E('300')], [held, true, E('200')], [v9, true, E('150')]);
for (const u of usd) inWindow.push([u, true, E('1000')]);

// --- mine blocks at chosen timestamps; ~3 blocks share each second-timestamp (sub-second blocks)
await g.request({ method: 'miner_stop', params: [] });
const ptx = portal.connect(signer), pitx = portalIdx.connect(signer);
async function block(ts, trades = [], idx = false) {
  if (trades.length) {
    const arg = trades.map(([token, buy, eth]) => ({ token, buy, eth }));
    await (idx ? pitx : ptx).emitTrades(arg, { gasLimit: 8_000_000 });
  }
  await g.request({ method: 'evm_mine', params: [{ timestamp: ts }] });
}
await block(BASE - 5000, [[old, true, E('999')], [valid[11], true, E('999')]]);     // before window
await block(BASE - 3601, [[valid[10], true, E('999')]]);                             // 1s before window
const groups = 60, perTs = 3, total = groups * perTs;
const blocksPlan = Array.from({ length: total }, () => []);
inWindow.forEach((t, i) => blocksPlan[(i * 7) % total].push(t));
for (let k = 0; k < total; k++) await block(FROM + Math.floor(k / perTs) * 60, blocksPlan[k]);
await block(BASE, [[edge, true, E('999')], [valid[9], true, E('999')]]);              // exactly at window end -> excluded
await block(BASE, [[edge, true, E('999')]]);
await block(BASE + 30, [[valid[9], true, E('999')]]);
await block(BASE + 40);
for (let k = 0; k < 20; k++) await block(BASE + 50 + k);
await block(BASE + 125);
const head = await provider.getBlock('latest');

// ---------------------------------------------------------------- block search
console.log('block <-> timestamp search');
const all = [];
for (let n = 0; n <= head.number; n++) all.push(Number((await provider.getBlock(n)).timestamp));
const brute = t => { const i = all.findIndex(x => x >= t); return i < 0 ? head.number + 1 : i; };
const clock = C.blockClock(provider);
const h = { number: head.number, timestamp: Number(head.timestamp) };
let allGood = true;
for (const t of [FROM, FROM + 1, FROM + 59, FROM + 60, BASE - 60, BASE - 1, BASE, BASE + 1, BASE + 125, BASE + 999, BASE - 5000, 0]) {
  const got = await C.firstBlockAtOrAfter(clock, t, h);
  if (got !== brute(t)) { allGood = false; console.log('   mismatch at', t, got, brute(t)); }
}
ok(allGood, 'firstBlockAtOrAfter matches brute force on 12 targets (incl. shared timestamps, edges)');
const r = await C.blockRange(provider, FROM, BASE, h);
eq([r.fromBlock, r.toBlock], [brute(FROM), brute(BASE) - 1], 'blockRange = [first ts>=from, last ts<to]');
ok(r.toBlock - r.fromBlock + 1 === total, `window holds exactly the ${total} in-window blocks`);

// ---------------------------------------------------------------- the ten
const expected = [...want.entries()]
  .sort((a, b) => (a[1] === b[1] ? (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1) : (a[1] > b[1] ? -1 : 1)))
  .slice(0, 10).map(([a]) => a);

console.log('ranking + filters (chunk 7 blocks)');
rpc.getLogs = 0;
const res = await C.computeCandidates({ provider, portal: P, vault: VV, toTs: BASE, chunk: 7, concurrency: 3 });
eq(res.list.map(x => x.address), expected, 'top 10 = valid coins by volume desc, tie broken by address asc');
ok(res.list.length === 10, 'exactly ten');
eq(res.list.map(x => x.bnbVolume1h), expected.map(a => ethers.formatEther(want.get(a))), 'bnbVolume1h = summed buys+sells in window only (old/edge trades excluded)');
ok(res.list.every(x => x.trades === 4), 'trades counted per token (4 each)');
const i3 = res.list.findIndex(x => x.address === valid[3]);
ok(i3 >= 0 && res.list[i3].progress === 0.8999, 'progress 0.8999 kept (< 0.9) and reported as float');
ok(!res.list.some(x => [grad, dex, arb, held, v9, old, edge, ...usd].includes(x.address)), 'excluded: graduating, DEX, $ARBITER, held, bad enum, out-of-window, USD-quoted');
ok(res.scan.checked > 25, `scanned past the first batch of 25 (checked ${res.scan.checked}) because 30 USD-quoted coins out-volume everything`);
eq(res.scan.rejected, { 'not BNB-quoted': 30, 'progress >= 90%': 1, 'not on curve': 1, 'held by vault': 1, 'state not decodable by vault': 1 }, 'rejection reasons');
ok(res.scan.getLogsCalls === Math.ceil(total / 7) && rpc.getLogs === res.scan.getLogsCalls, `chunked getLogs: ${res.scan.getLogsCalls} calls of <= 7 blocks`);
ok(res.arbiter === arb, '$ARBITER read from vault.arbiterToken()');
const c2 = res.list.find(x => x.address === valid[2]);
ok(c2 && c2.name === 'Evilname that is way too ' .slice(0, 24) && !/[\u0000-\u001f\u202E]/.test(c2.name + c2.symbol) && c2.symbol === 'EVIL', `names sanitized + capped: "${c2?.name}" / "${c2?.symbol}"`);
const c0 = res.list.find(x => x.address === valid[0]);
eq([c0.meta, c0.image], [META_CID, process.env.IPFS_GATEWAY + IMG_CID], 'meta CID via metaURI() -> metadata JSON -> image URL');
ok(res.list.find(x => x.address === valid[1]).image === null, 'no metaURI -> image null');
eq([res.from, res.to, res.window], [FROM, BASE, '60m'], 'window fields');

console.log('RPC that rejects ranges > 20 blocks, chunk 50 -> automatic splitting');
rpc.limit = 20; rpc.rejected = 0;
const res2 = await C.computeCandidates({ provider, portal: P, vault: VV, toTs: BASE, chunk: 50, withMeta: false });
eq(res2.list.map(x => x.address), expected, 'same ten after splits');
ok(rpc.rejected > 0, `RPC rejected ${rpc.rejected} wide ranges and the scanner split them`);
rpc.limit = Infinity;

console.log('default window end = start of the head minute');
const res3 = await C.computeCandidates({ provider, portal: P, vault: VV, withMeta: false });
ok(res3.to === Math.floor(Number(head.timestamp) / 60) * 60 && res3.to - res3.from === 3600, `to=${res3.to} from=${res3.from}`);

console.log('held coin drops out, next one moves up');
await vaultView.setHolding(valid[0], true); await block(BASE + 200);
const res4 = await C.computeCandidates({ provider, portal: P, vault: VV, toTs: BASE, withMeta: false });
eq(res4.list.map(x => x.address), [...expected.slice(1), valid[10]], 'valid[0] excluded, valid[10] enters at #10');

console.log('state at an old block (verify mode uses blockTag)');
const res5 = await C.computeCandidates({ provider, portal: P, vault: VV, toTs: BASE, withMeta: false, blockTag: head.number });
eq(res5.list.map(x => x.address), expected, 'blockTag before the holding change -> original ten');
await vaultView.setHolding(valid[0], false); await block(BASE + 201);

console.log('indexed-event variant (same topic0)');
// fresh window on the indexed portal: [BASE+1000, BASE+4600)
const B2 = BASE + 4600;
const plan2 = Array.from({ length: 30 }, () => []);
inWindow.forEach((t, i) => plan2[i % 30].push(t));
for (let k = 0; k < 30; k++) await block(B2 - 3600 + k * 100, plan2[k], true);
await block(B2 + 5);
const res6 = await C.computeCandidates({ provider, portal: PI, vault: VV, toTs: B2, chunk: 4, withMeta: false });
eq(res6.list.map(x => x.address), expected, 'indexed token/trader events decode to the same ten');

console.log('getLogs budget: RPC that rejects every getLogs fails fast');
rpc.limit = 0; rpc.getLogs = 0;
let threw = null;
try { await C.computeCandidates({ provider, portal: P, vault: VV, toTs: BASE, chunk: 7, withMeta: false }); } catch (e) { threw = e; }
ok(threw && /gave up after|getLogs \d+-\d+ failed/.test(threw.message) && rpc.getLogs < 600, `fails fast with a clear message (${rpc.getLogs} calls): ${threw?.message?.slice(0, 60)}`);

gw.close();
done();
