// Recompute the public rule for a past round so anyone can check the keeper handed in the right ten.
//
//   node scripts/verify-candidates.mjs --round 12            # reads askedAt + the ten from the vault, compares
//   node scripts/verify-candidates.mjs 1767225600            # any unix time (treated as a round's askedAt)
//   options: --vault 0x… (else VAULT_ADDRESS / deployments.json)  --testnet  --chunk 3000
//
// Window: [M-3600, M), M = start of the minute of askedAt (the keeper computes the list in the same minute it
// asks; if that doesn't match, the previous minute is tried too). State (curve status/progress, vault holdings)
// is read at the block just before the ask, so this needs an RPC that serves historical state (archive node)
// for anything older than ~a few hours on most providers. Logs work on any getLogs-capable RPC.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  round: { type: 'string' }, vault: { type: 'string' }, testnet: { type: 'boolean' }, chunk: { type: 'string' },
} });
if (o.testnet) process.env.CHAIN_ID = '97';
const { ethers } = await import('ethers');
const { addresses, getProvider, vaultContract, chainId } = await import('../api/_lib/chain.js');
const C = await import('../api/_lib/candidates.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const depFile = path.join(root, 'deployments.json');
const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8'))[chainId()] : null;
const vaultAddr = o.vault || addresses().vault || dep?.vault || null;

const p = getProvider();
const vault = vaultAddr ? vaultContract(p, ethers.getAddress(vaultAddr)) : null;
let askedAt, onchain = null, round = null;

if (o.round != null) {
  if (!vault) { console.error('--round needs the vault address (--vault or VAULT_ADDRESS)'); process.exit(1); }
  round = Number(o.round);
  const r = await vault.getRound(round);
  askedAt = Number(r.askedAt);
  onchain = [...r.candidates].map(a => ethers.getAddress(a));
} else if (positionals[0]) {
  askedAt = Number(positionals[0]);
} else { console.error('usage: verify-candidates.mjs <askedAt unix> | --round N'); process.exit(1); }

// the block the ask landed in (Asked event) -> read state one block earlier
const head = await p.getBlock('latest');
const h = { number: head.number, timestamp: Number(head.timestamp) };
const clock = C.blockClock(p);
const firstAt = await C.firstBlockAtOrAfter(clock, askedAt, h);
let stateBlock = firstAt - 1;
if (vault && round != null) {
  const lastAt = (await C.firstBlockAtOrAfter(clock, askedAt + 1, h, firstAt)) - 1;
  const ev = vault.interface.getEvent('Asked');
  const logs = await p.getLogs({ address: vault.target, topics: [ev.topicHash, ethers.toBeHex(round, 32)], fromBlock: firstAt, toBlock: Math.max(firstAt, lastAt) });
  if (logs[0]) stateBlock = logs[0].blockNumber - 1;
}

const M = Math.floor(askedAt / 60) * 60;
console.log(`askedAt ${askedAt} (${new Date(askedAt * 1000).toISOString()})  state @ block ${stateBlock}  vault ${vault?.target ?? '(none: holdings not checked)'}`);
console.log(`rule: ${C.RULE}\n`);

let res, used;
for (const end of [M, M - 60]) {
  res = await C.computeCandidates({ provider: p, vault: vault ? vault.target : null, toTs: end, blockTag: stateBlock, withImage: false, chunk: o.chunk ? Number(o.chunk) : undefined });
  used = end;
  if (!onchain || JSON.stringify(res.list.map(x => x.address)) === JSON.stringify(onchain)) break;
}

console.log(`window [${res.from}, ${res.to})  blocks ${res.blocks.from}..${res.blocks.to}  ${res.scan.trades} trades, ${res.scan.tokensTraded} coins traded\n`);
console.log(' #  address                                      symbol            BNB 1h  trades  curve');
res.list.forEach((x, i) => {
  const mark = onchain ? (onchain[i] === x.address ? ' ok' : ` <> on-chain ${onchain[i]}`) : '';
  console.log(`${String(i).padStart(2)}  ${x.address}  ${(x.symbol || '?').padEnd(12)} ${Number(x.bnbVolume1h).toFixed(4).padStart(11)}  ${String(x.trades).padStart(6)}  ${(x.progress * 100).toFixed(1).padStart(5)}%${mark}`);
});
if (res.errors.length) console.log('\nwarnings:', res.errors);
if (onchain) {
  const same = JSON.stringify(res.list.map(x => x.address)) === JSON.stringify(onchain);
  console.log(same
    ? `\nMATCH: round ${round}'s ten are exactly the rule's ten${used !== M ? ' (keeper computed in the previous minute)' : ''}.`
    : '\nMISMATCH: the on-chain ten differ from the rule (see rows above). Check RPC archive support before concluding.');
  process.exit(same ? 0 : 2);
}
