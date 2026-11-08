// End-to-end on ganache: the REAL ArbiterVault bytecode (api/_lib/vault-abi.json) + mock Portal/provider,
import { EventEmitter } from "node:events"; EventEmitter.defaultMaxListeners = 50;
// driving the actual /api/tick, /api/stats and /api/candidates handlers over HTTP JSON-RPC.
// Run: node scripts/test-e2e.mjs
import ganache from 'ganache';
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import { compile, deploy, ok, eq, done, ganacheAccounts, KEYS } from './_testkit.mjs';

const require = createRequire(import.meta.url);
const VAULT = require('../api/_lib/vault-abi.json');
const E = ethers.parseEther;

const server = ganache.server({
  logging: { quiet: true },
  chain: { chainId: 1337, time: new Date('2030-01-01T00:00:00Z') },
  wallet: { accounts: ganacheAccounts() },
});

await server.listen(0);
const port = server.address().port;
const url = `http://127.0.0.1:${port}`;
const provider = new ethers.JsonRpcProvider(url, 1337, { staticNetwork: true, cacheTimeout: -1 });
const owner = new ethers.Wallet(KEYS[0], provider);
const keeper = new ethers.Wallet(KEYS[1], provider);
const rnd = new ethers.Wallet(KEYS[2], provider);
const rpc = (m, p = []) => provider.send(m, p);
const warp = async s => { await rpc('evm_increaseTime', [s]); await rpc('evm_mine', []); };
const T = compile();
const tx = async p => (await p).wait();

console.log('deploy');
const portal = await deploy(owner, T.TPortal);
const ai = await deploy(owner, T.TProvider);
const vault = await deploy(owner, VAULT, await portal.getAddress(), await ai.getAddress(), ethers.ZeroAddress, keeper.address);
const V = await vault.getAddress();
const toks = [];
for (let i = 0; i < 12; i++) toks.push(await (await deploy(owner, T.TToken, `Coin ${i}`, `C${i}`, '')).getAddress());
const arb = await (await deploy(owner, T.TToken, 'ARBITER', 'ARBITER', '')).getAddress();
for (const t of [...toks, arb]) await tx(portal.set(t, 1, ethers.ZeroAddress, E('0.3'), 10n ** 12n));
await tx(vault.setArbiterToken(arb));
await tx(owner.sendTransaction({ to: await portal.getAddress(), value: E('50') }));
await tx(rnd.sendTransaction({ to: V, value: E('2') })); // "tax"

const trades = (list) => tx(portal.connect(rnd).emitTrades(list.map(([token, eth]) => ({ token, buy: true, eth })), { gasLimit: 8_000_000 }));
await trades([...toks.map((t, i) => [t, E(String(30 - i))]), [arb, E('500')]]);
await warp(120); // trades now sit before the start of the current minute

process.env.CHAIN_ID = '1337';
process.env.BSC_RPC = url;
process.env.PORTAL = await portal.getAddress();
process.env.AI_PROVIDER = await ai.getAddress();
process.env.VAULT_ADDRESS = V;
process.env.KEEPER_PK = KEYS[1];
process.env.CRON_SECRET = 'test-secret';
process.env.IPFS_GATEWAY = 'http://127.0.0.1:9/ipfs/';

const tick = (await import('../api/tick.js')).default;
const stats = (await import('../api/stats.js')).default;
const cands = (await import('../api/candidates.js')).default;

function call(handler, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, 'http://x');
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(b) : null }); },
    };
    Promise.resolve(handler({ method: 'GET', url: path, headers, query: Object.fromEntries(u.searchParams) }, res)).catch(reject);
  });
}
const auth = { authorization: 'Bearer test-secret' };

console.log('stats before anything');
let s = (await call(stats, '/api/stats')).body;
ok(s.live === true && s.bankrollBnb === '2.0' && s.counts.rounds === 0 && s.rounds.length === 0, 'live, bankroll 2 BNB, no rounds');
eq([s.modelName, s.questionFeeBnb, s.token, s.totals.taxInBnb, s.pending.requestId], ['anthropic/claude-sonnet-4.6', '0.05', arb, '2.0', null], 'model, fee, token, tax, no pending');

console.log('candidates endpoint');
const cr = await call(cands, '/api/candidates');
ok(cr.status === 200 && cr.headers['cache-control'] === 's-maxage=60, stale-while-revalidate=120' && cr.headers['access-control-allow-origin'] === '*', 'cache + CORS headers');
eq(cr.body.list.map(x => x.address), toks.slice(0, 10), 'ten by volume, $ARBITER excluded');
eq(cr.body.list[0], { rank: 1, address: toks[0], bnbVolume1h: '30.0', trades: 1, progress: 0.3, name: 'Coin 0', symbol: 'C0', meta: null, image: null }, 'list item shape');

console.log('tick auth');
eq((await call(tick, '/api/tick')).status, 401, 'no secret -> 401');
eq((await call(tick, '/api/tick?key=wrong')).status, 401, 'wrong key -> 401');

console.log('tick dry');
let t = (await call(tick, '/api/tick?dry=1&key=test-secret')).body;
const dryAsk = t.steps.find(x => x.step === 'ask');
ok(t.dry && dryAsk?.ok && dryAsk.dry && !dryAsk.hash, 'dry run simulates ask, sends nothing');
ok(t.oracle?.maxPromptLength === '4096', 'dry run reports oracle maxPromptLength / callbackGasLimit');
eq(Number(await vault.roundsCount()), 0, 'still no round on-chain');

console.log('tick: ask');
t = (await call(tick, '/api/tick', auth)).body;
const ask = t.steps.find(x => x.step === 'ask');
ok(t.ok && ask?.ok && ask.hash && ask.asked?.round === 0 && ask.asked.requestId === '1', `asked round 0, request 1 (gas ${ask?.gasUsed})`);
eq(t.candidates.list.map(x => x.address), toks.slice(0, 10), 'keeper handed in the rule\'s ten');
const prompt = await ai.lastPrompt();
ok(prompt.includes(toks[3].toLowerCase()) && prompt.includes('ave_token_tool'), 'prompt built on-chain with the ten addresses');

t = (await call(tick, '/api/tick', auth)).body;
ok(/pending \(PENDING\)/.test(t.skipped), `second tick skips: ${t.skipped}`);

console.log('oracle answers #3 -> vault buys');
await tx(ai.fulfill(1, 3, 'bafkreibwjuzzns6yf4wytfr5nk6vujb4yja4iejff2k76nshn2z5jkmiy4'));
s = (await call(stats, '/api/stats')).body;
const r0 = s.rounds[0], p0 = s.positions[0];
eq([r0.choice, r0.bought, r0.status, r0.pick?.address, r0.pick?.symbol, r0.size, r0.fee], [3, true, 'FULFILLED', toks[3], 'C3', '0.2', '0.05'], 'round 0 answered and bought');
eq([r0.cid, r0.proofUrl], ['bafkreibwjuzzns6yf4wytfr5nk6vujb4yja4iejff2k76nshn2z5jkmiy4', 'https://ipfs.io/ipfs/bafkreibwjuzzns6yf4wytfr5nk6vujb4yja4iejff2k76nshn2z5jkmiy4'], 'reasoning CID from provider.getRequest');
eq([p0.token, p0.open, p0.cost, p0.valueNow, p0.pnlPct, p0.exitReason, s.counts.open], [toks[3], true, '0.2', '0.2', 0, '', 1], 'position open, valued, not closable');

console.log('price doubles -> tick closes with "2x" and burns profit');
await tx(portal.setPrice(toks[3], 2n * 10n ** 12n));
s = (await call(stats, '/api/stats')).body;
eq([s.positions[0].valueNow, s.positions[0].pnlPct, s.positions[0].exitReason], ['0.4', 100, '2x'], 'stats shows 2x');
t = (await call(tick, '/api/tick', auth)).body;
const cl = t.steps.find(x => x.step.startsWith('close(0)'));
ok(cl?.ok && cl.closed?.why === '2x' && cl.closed.bnbOut === E('0.4').toString(), `closed position 0: ${JSON.stringify(cl?.closed)}`);
ok(/too soon/.test(t.skipped), `then skips ask: ${t.skipped}`);
s = (await call(stats, '/api/stats')).body;
eq([s.positions[0].open, s.positions[0].proceeds, s.positions[0].pnlPct, s.totals.burnedBnb, s.totals.soldBnb, s.counts.open], [false, '0.4', 100, '0.2', '0.4', 0], 'closed, profit 0.2 BNB bought $ARBITER and burned');

console.log('an hour later: stale volume -> skip; fresh volume -> ask round 1');
await warp(3601);
t = (await call(tick, '/api/tick', auth)).body;
ok(/only 1 coins/.test(t.skipped), `skips (only the vault's own sell of C3 is in the window): ${t.skipped}`);
await trades(toks.map((x, i) => [x, E(String(1 + i))]));
await warp(61);
t = (await call(tick, '/api/tick', auth)).body;
const ask2 = t.steps.find(x => x.step === 'ask');
ok(ask2?.ok && ask2.asked?.round === 1, 'asked round 1');
eq(t.candidates.list.map(x => x.address), [...toks].reverse().slice(0, 10), 'new ten ranked by fresh volume');

console.log('refusals surface as decoded custom errors');
await tx(ai.fulfill(2, 0, 'bafkreibwjuzzns6yf4wytfr5nk6vujb4yja4iejff2k76nshn2z5jkmiy4')); // buys toks[11]
await warp(3601);
await trades(toks.map((x, i) => [x, E(String(1 + i))]));
await warp(61);
await tx(vault.setKeeper(rnd.address)); // keeper key no longer authorised
t = (await call(tick, '/api/tick', auth)).body;
const ask3 = t.steps.find(x => x.step === 'ask');
ok(t.warning && ask3 && ask3.ok === false && ask3.error === 'NotKeeper()', `ask refused with ${ask3?.error}`);
ok(!t.candidates.list.some(x => x.address === toks[11]), 'held coin (toks[11]) excluded from the ten');

console.log('scripts/verify-candidates.mjs recomputes past rounds');
const { execFile } = await import('node:child_process');
const run = args => new Promise(r => execFile(process.execPath, args, { env: process.env, encoding: 'utf8' }, (err, stdout, stderr) => r({ status: err ? err.code : 0, stdout, stderr })));
for (const rn of [0, 1]) {
  const out = await run(['scripts/verify-candidates.mjs', '--round', String(rn)]);
  if (rn === 1) console.log(out.stdout.split('\n').map(l => '      | ' + l).join('\n'));
  ok(out.status === 0 && /MATCH: round/.test(out.stdout), `round ${rn}: exit ${out.status} ${(out.stdout.match(/MATCH.*|MISMATCH.*/) || [out.stderr.slice(-200)])[0]}`);
}

console.log('\nsample /api/stats (trimmed):');
s = (await call(stats, '/api/stats')).body;
console.log(JSON.stringify({ ...s, rounds: s.rounds.slice(0, 1), positions: s.positions.slice(0, 2) }, null, 2));
ok(Array.isArray(s.errors) && s.errors.length === 0, 'no read errors');

await server.close();
done();
