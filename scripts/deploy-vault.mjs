// Deploy ArbiterVault(portal, provider, router, keeper) from DEPLOYER_PK.
//   node scripts/deploy-vault.mjs [--testnet] [--keeper 0x..] [--portal 0x..] [--provider 0x..] [--router 0x..] [--artifact path] [--dry]
// Keeper defaults to the address of KEEPER_PK. Writes ./deployments.json (keyed by chain id).
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values: o } = parseArgs({ options: {
  testnet: { type: 'boolean' }, dry: { type: 'boolean' }, keeper: { type: 'string' }, portal: { type: 'string' },
  provider: { type: 'string' }, router: { type: 'string' }, artifact: { type: 'string' },
} });
if (o.testnet) { process.env.CHAIN_ID = '97'; }
const { ethers } = await import('ethers');
const { CHAINS, addresses, getProvider, chainId } = await import('../api/_lib/chain.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bundled = path.join(root, 'api/_lib/vault-abi.json');
const source = path.resolve(root, '../contracts/out/ArbiterVault.json');
const artPath = o.artifact || (fs.existsSync(source) ? source : bundled);
const art = JSON.parse(fs.readFileSync(artPath, 'utf8'));
if (artPath !== bundled && fs.existsSync(bundled)) {
  const b = JSON.parse(fs.readFileSync(bundled, 'utf8'));
  if (b.bytecode !== art.bytecode) console.warn(`WARNING: ${artPath} differs from api/_lib/vault-abi.json — copy it over so the site reads the same ABI.`);
}

const a = addresses();
const portal = ethers.getAddress(o.portal || a.portal);
const prov = ethers.getAddress(o.provider || a.aiProvider);
const router = ethers.getAddress(o.router || a.router);
let keeper = o.keeper || (process.env.KEEPER_PK ? new ethers.Wallet(process.env.KEEPER_PK).address : null);
if (!keeper) { console.error('need --keeper 0x… or KEEPER_PK'); process.exit(1); }
keeper = ethers.getAddress(keeper);

const p = getProvider(process.env.BSC_RPC || CHAINS[chainId()]?.rpc);
const net = await p.send('eth_chainId', []);
if (Number(net) !== chainId()) { console.error(`RPC is chain ${Number(net)}, expected ${chainId()} (use --testnet for 97)`); process.exit(1); }

console.log({ chainId: chainId(), artifact: path.relative(process.cwd(), artPath), portal, provider: prov, router, keeper });
for (const [k, v] of Object.entries({ portal, provider: prov, router })) {
  const code = await p.getCode(v);
  if (code === '0x') { console.error(`${k} ${v} has no code on chain ${chainId()}`); process.exit(1); }
}
if (o.dry) { console.log('--dry: not deploying'); process.exit(0); }
if (!process.env.DEPLOYER_PK) { console.error('DEPLOYER_PK not set'); process.exit(1); }

const w = new ethers.Wallet(process.env.DEPLOYER_PK, p);
console.log('deployer', w.address, 'balance', ethers.formatEther(await p.getBalance(w.address)), 'BNB');
const f = new ethers.ContractFactory(art.abi, art.bytecode, w);
const c = await f.deploy(portal, prov, router, keeper);
console.log('tx', c.deploymentTransaction().hash);
await c.waitForDeployment();
const vault = await c.getAddress();
const rc = await c.deploymentTransaction().wait();
console.log('\nVAULT_ADDRESS =', vault, '\n');
console.log('checks', { portal: await c.portal(), provider: await c.provider(), wbnb: await c.wbnb(), keeper: await c.keeper(), owner: await c.owner() });

const file = path.join(root, 'deployments.json');
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
all[chainId()] = { ...(all[chainId()] || {}), vault, portal, provider: prov, router, keeper, owner: w.address, vaultTx: rc.hash, vaultBlock: rc.blockNumber, deployedAt: new Date().toISOString() };
fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
console.log('wrote', file);
