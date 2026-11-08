// Launch $ARBITER on Flap: Portal.newTokenV6 as a TOKEN_TAXED_V3 tax token (3% buy / 3% sell, all to the vault),
// vanity address ending in 7777, then vault.setArbiterToken(token).
//
//   node scripts/launch-token.mjs --image ./arbiter.png --description "…" --website https://… --twitter https://x.com/… \
//        [--telegram …] [--quote-amt 0] [--vault 0x…] [--meta <CID>] [--salt 0x…] [--testnet] [--dry] [--no-set-token]
//
// --dry   prints params + predicted address; no upload, no tx. If DEPLOYER_PK is set it also simulates newTokenV6 (eth_call).
// Env: DEPLOYER_PK (must be the vault owner for setArbiterToken), BSC_RPC, VAULT_ADDRESS (or deployments.json / --vault).
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values: o } = parseArgs({ options: {
  image: { type: 'string' }, description: { type: 'string' }, website: { type: 'string' }, twitter: { type: 'string' },
  telegram: { type: 'string' }, meta: { type: 'string' }, 'quote-amt': { type: 'string', default: '0' }, vault: { type: 'string' },
  salt: { type: 'string' }, impl: { type: 'string' }, suffix: { type: 'string', default: '7777' },
  'anti-farmer': { type: 'string', default: '3600' }, 'dex-thresh': { type: 'string', default: 'FOUR_FIFTHS' },
  name: { type: 'string', default: 'ARBITER' }, symbol: { type: 'string', default: 'ARBITER' },
  testnet: { type: 'boolean' }, dry: { type: 'boolean' }, 'no-set-token': { type: 'boolean' },
} });
if (o.testnet) process.env.CHAIN_ID = '97';
const { ethers } = await import('ethers');
const { CHAINS, addresses, getProvider, chainId, portalContract, vaultContract, decodeRevert, PORTAL_ABI } = await import('../api/_lib/chain.js');

// ---- enums (IPortal.sol order)
const DexThreshType = { TWO_THIRDS: 0, FOUR_FIFTHS: 1, HALF: 2, _95_PERCENT: 3, _81_PERCENT: 4, _1_PERCENT: 5 };
const MigratorType = { V3_MIGRATOR: 0, V2_MIGRATOR: 1, V4_UNI_MIGRATOR: 2, PCS_INFINITY_CL_MIGRATOR: 3 };
const TokenVersion = { TOKEN_TAXED_V3: 6 };
const DEXId = { DEX0: 0 };
const V3LPFeeProfile = { LP_FEE_PROFILE_STANDARD: 0 };
const TAX_DURATION_100Y = 100n * 365n * 24n * 60n * 60n; // 3,153,600,000 s — "max: 100 years" (365-day years, so we never exceed it)

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const depFile = path.join(root, 'deployments.json');
const deployments = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8')) : {};

const cid = chainId();
const p = getProvider(process.env.BSC_RPC || CHAINS[cid]?.rpc);
const net = Number(await p.send('eth_chainId', []));
if (net !== cid) { console.error(`RPC is chain ${net}, expected ${cid} (use --testnet for 97)`); process.exit(1); }
const portalAddr = addresses().portal;
const impl = ethers.getAddress(o.impl || CHAINS[cid]?.taxTokenV3Impl || '');
const vaultAddr = o.vault || addresses().vault || deployments[cid]?.vault;
if (!vaultAddr) { console.error('vault address needed: --vault, VAULT_ADDRESS or deployments.json'); process.exit(1); }
const beneficiary = ethers.getAddress(vaultAddr);
if ((await p.getCode(beneficiary)) === '0x') { console.error(`vault ${beneficiary} has no code on chain ${cid}`); process.exit(1); }
const wallet = process.env.DEPLOYER_PK ? new ethers.Wallet(process.env.DEPLOYER_PK, p) : null;
if (!wallet && !o.dry) { console.error('DEPLOYER_PK not set'); process.exit(1); }

// ---- vanity salt: exactly Flap's findVanityTokenSalt (docs: launch-token-through-portal)
// CREATE2 from the Portal, init code = EIP-1167 minimal proxy of the token implementation.
const initCode = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' + impl.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
const initCodeHash = ethers.keccak256(initCode);
const predict = salt => ethers.getCreate2Address(portalAddr, salt, initCodeHash);

function mineSalt(suffix) {
  if (!/^[0-9a-f]{4}$/i.test(suffix)) throw new Error('suffix must be 4 hex chars');
  // fast path: hash 0xff ++ portal ++ salt ++ initCodeHash ourselves, compare the last 2 bytes
  const buf = new Uint8Array(85);
  buf[0] = 0xff; buf.set(ethers.getBytes(portalAddr), 1); buf.set(ethers.getBytes(initCodeHash), 53);
  const want = suffix.toLowerCase();
  let salt = ethers.keccak256(ethers.randomBytes(32)); // docs: keccak256(random seed), then salt = keccak256(salt)
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    buf.set(ethers.getBytes(salt), 21);
    const h = ethers.keccak256(buf);
    if (h.endsWith(want)) {
      const addr = predict(salt);
      if (!addr.toLowerCase().endsWith(want)) throw new Error('fast path disagrees with getCreate2Address');
      console.log(`  found after ${i} tries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { salt, address: addr };
    }
    if (i % 50000 === 0) process.stdout.write(`  mining… ${i} tries, ${Math.round(i / ((Date.now() - t0) / 1000))}/s\r`);
    salt = ethers.keccak256(salt);
  }
}

// ---- metadata upload: Flap's GraphQL multipart endpoint (docs: launch-token-through-portal)
async function uploadMeta() {
  if (!o.image) throw new Error('--image is required (or pass --meta <CID>)');
  const file = fs.readFileSync(o.image);
  const ext = path.extname(o.image).toLowerCase();
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
  const meta = {
    website: o.website || null, twitter: o.twitter || null, telegram: o.telegram || null,
    description: o.description || null, creator: ethers.ZeroAddress, // docs example uses the zero address
  };
  const form = new FormData();
  form.append('operations', JSON.stringify({
    query: 'mutation Create($file: Upload!, $meta: MetadataInput!) { create(file: $file, meta: $meta) }',
    variables: { file: null, meta },
  }));
  form.append('map', JSON.stringify({ 0: ['variables.file'] }));
  form.append('0', new Blob([file], { type }), 'image' + (ext || '.png'));
  const r = await fetch('https://funcs.flap.sh/api/upload', { method: 'POST', body: form });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`upload HTTP ${r.status}: ${text.slice(0, 300)}`);
  const cidOut = JSON.parse(text)?.data?.create;
  if (!cidOut) throw new Error('upload: no CID in ' + text.slice(0, 300));
  return cidOut;
}

// ---- go
console.log({ chainId: cid, portal: portalAddr, taxTokenV3Impl: impl, beneficiary, wallet: wallet?.address ?? '(none, dry)' });

let salt, predicted;
if (o.salt) { salt = ethers.hexlify(ethers.getBytes(o.salt)); predicted = predict(salt); }
else { console.log(`mining vanity salt for …${o.suffix}`); ({ salt, address: predicted } = mineSalt(o.suffix)); }
if (!predicted.toLowerCase().endsWith(o.suffix.toLowerCase())) { console.error(`salt gives ${predicted}, not …${o.suffix}`); process.exit(1); }
if ((await p.getCode(predicted)) !== '0x') { console.error(`${predicted} already deployed — use a new salt`); process.exit(1); }

let meta = o.meta;
if (!meta) {
  if (o.dry) { meta = 'bafkreidryrunplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; console.log('--dry: metadata NOT uploaded; placeholder CID used'); }
  else { console.log('uploading image + metadata to funcs.flap.sh …'); meta = await uploadMeta(); console.log('meta CID', meta); }
}

const quoteAmt = ethers.parseEther(o['quote-amt']);
if (!(o['dex-thresh'] in DexThreshType)) { console.error('bad --dex-thresh'); process.exit(1); }
// Field order = IPortal.sol NewTokenV6Params (verified against flap-sh/FlapVaultExample src/flap/IPortal.sol)
const params = {
  name: o.name,
  symbol: o.symbol,
  meta,
  dexThresh: DexThreshType[o['dex-thresh']],
  salt,
  migratorType: MigratorType.V2_MIGRATOR, // tax tokens must use V2
  quoteToken: ethers.ZeroAddress,         // BNB
  quoteAmt,
  beneficiary,                            // tax -> ArbiterVault.receive()
  permitData: '0x',
  extensionID: ethers.ZeroHash,
  extensionData: '0x',
  dexId: DEXId.DEX0,
  lpFeeProfile: V3LPFeeProfile.LP_FEE_PROFILE_STANDARD,
  buyTaxRate: 300,
  sellTaxRate: 300,
  taxDuration: TAX_DURATION_100Y,
  antiFarmerDuration: BigInt(o['anti-farmer']), // docs example 3600; Portal has AntiFarmerDurationTooShort, so 0 may revert
  mktBps: 10000,
  deflationBps: 0,
  dividendBps: 0,
  lpBps: 0,
  minimumShareBalance: 0n,
  dividendToken: ethers.ZeroAddress,
  commissionReceiver: ethers.ZeroAddress,
  tokenVersion: TokenVersion.TOKEN_TAXED_V3,
};
console.log('\nnewTokenV6 params:'); console.log(params);
console.log('msg.value', ethers.formatEther(quoteAmt), 'BNB');
console.log('\npredicted token address:', predicted, '\n');

const portal = portalContract(wallet || p, portalAddr);
const calldata = portal.interface.encodeFunctionData('newTokenV6', [params]); // throws if any field type is wrong
console.log('calldata', calldata.slice(0, 10), `(${(calldata.length - 2) / 2} bytes)`);
if (wallet) {
  try {
    const sim = await portal.newTokenV6.staticCall(params, { value: quoteAmt });
    console.log('simulation returns', sim, sim === predicted ? '(matches prediction)' : '(DOES NOT MATCH prediction — check --impl)');
    if (sim !== predicted && !o.dry) process.exit(1);
  } catch (e) {
    console.error('simulation reverted:', decodeRevert(e));
    if (!o.dry) process.exit(1);
  }
}
if (o.dry) { console.log(`--dry: nothing sent. To launch this exact address re-run without --dry and add --salt ${salt}`); process.exit(0); }

const est = await portal.newTokenV6.estimateGas(params, { value: quoteAmt });
const tx = await portal.newTokenV6(params, { value: quoteAmt, gasLimit: (est * 130n) / 100n });
console.log('launch tx', tx.hash);
const rc = await tx.wait();
const iface = new ethers.Interface(PORTAL_ABI);
let token = null;
for (const l of rc.logs) {
  if (l.address.toLowerCase() !== portalAddr.toLowerCase()) continue;
  try { const e = iface.parseLog(l); if (e?.name === 'TokenCreated') token = ethers.getAddress(e.args.token); } catch {}
}
token = token || predicted;
console.log('\nARBITER_TOKEN =', token, token === predicted ? '' : `(predicted ${predicted}!)`);

const all = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8')) : {};
all[cid] = { ...(all[cid] || {}), token, tokenTx: rc.hash, tokenBlock: rc.blockNumber, meta, salt, vault: beneficiary };
fs.writeFileSync(depFile, JSON.stringify(all, null, 2) + '\n');

if (!o['no-set-token']) {
  const v = vaultContract(wallet, beneficiary);
  const owner = await v.owner();
  if (owner !== wallet.address) console.error(`vault owner is ${owner}, not ${wallet.address}: call setArbiterToken(${token}) from the owner`);
  else if ((await v.arbiterToken()) !== ethers.ZeroAddress) console.log('vault.arbiterToken already set:', await v.arbiterToken());
  else { const t2 = await v.setArbiterToken(token); await t2.wait(); console.log('vault.setArbiterToken done', t2.hash); }
}
console.log('wrote', depFile);
