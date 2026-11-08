// Chain wiring: provider, addresses, minimal ABIs, contract factories.
// Everything reads process.env lazily (at call time) so scripts/tests can set env first.
import { createRequire } from 'node:module';
import { Contract, FetchRequest, Interface, JsonRpcProvider, Network, ZeroAddress, getAddress, isAddress } from 'ethers';
import { EXTERNAL_ERRORS } from './errors.js';

const require = createRequire(import.meta.url);
const VAULT_ARTIFACT = require('./vault-abi.json'); // copy of contracts/out/ArbiterVault.json ({abi, bytecode})
export const VAULT_ABI = VAULT_ARTIFACT.abi;
export const VAULT_BYTECODE = VAULT_ARTIFACT.bytecode;

// ---- defaults per chain (env always wins)
export const CHAINS = {
  56: {
    name: 'bsc',
    rpc: 'https://bsc-rpc.publicnode.com',
    portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
    aiProvider: '0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39',
    router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    taxTokenV3Impl: '0x024f18294970B5c76c0691b87f138A0317156422', // docs "Tax Token V3 Impl", vanity 7777
    wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },
  97: {
    name: 'bsc-testnet',
    rpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    portal: '0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9',
    aiProvider: '0xFfddcE44e8cFf7703Fd85118524bfC8B2f70b744',
    router: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1',
    taxTokenV3Impl: '0xE6Ff967a887084c16D0fD71548CF709542cc1557', // docs "Tax Token V3 Impl" (testnet)
    wbnb: null,
  },
};

export function chainId() {
  const v = parseInt(process.env.CHAIN_ID || '56', 10);
  return Number.isFinite(v) ? v : 56;
}
const defaults = () => CHAINS[chainId()] || CHAINS[56];

function addrEnv(name, fallback, required = false) {
  const v = (process.env[name] || '').trim();
  if (v) {
    if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
    return getAddress(v);
  }
  if (required) return null;
  return fallback ? getAddress(fallback) : null;
}

export function addresses() {
  const d = defaults();
  return {
    chainId: chainId(),
    portal: addrEnv('PORTAL', d.portal),
    aiProvider: addrEnv('AI_PROVIDER', d.aiProvider),
    router: addrEnv('PANCAKE_V2_ROUTER', d.router),
    vault: addrEnv('VAULT_ADDRESS', null, true),
    arbiterToken: addrEnv('ARBITER_TOKEN', null, true),
  };
}

// ---- provider (cached per RPC URL for warm lambdas)
const _providers = new Map();
export function getProvider(url = process.env.BSC_RPC || defaults().rpc) {
  const key = `${url}|${chainId()}`;
  if (_providers.has(key)) return _providers.get(key);
  const req = new FetchRequest(url);
  req.timeout = parseInt(process.env.RPC_TIMEOUT_MS || '15000', 10);
  const net = Network.from(chainId());
  const p = new JsonRpcProvider(req, net, {
    staticNetwork: net,
    batchMaxCount: parseInt(process.env.RPC_BATCH || '1', 10), // 1 = no JSON-RPC batching (safest with public RPCs)
    polling: false,
    cacheTimeout: -1, // no 250ms request cache: the keeper sends txs back to back and needs fresh nonces/state
  });
  _providers.set(key, p);
  return p;
}

// ---- minimal ABIs
// Portal: events exactly as in IPortal.sol (no indexed args), TokenStateV8 with enums as uint8 (ABI-identical).
export const TOKEN_STATE_V8 =
  'tuple(uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 h, uint256 k, uint256 dexSupplyThresh, address quoteTokenAddress, bool nativeToQuoteSwapEnabled, bytes32 extensionID, uint256 buyTaxRate, uint256 sellTaxRate, address pool, uint256 progress, uint8 lpFeeProfile, uint8 dexId)';

export const NEW_TOKEN_V6_PARAMS =
  'tuple(string name, string symbol, string meta, uint8 dexThresh, bytes32 salt, uint8 migratorType, address quoteToken, uint256 quoteAmt, address beneficiary, bytes permitData, bytes32 extensionID, bytes extensionData, uint8 dexId, uint8 lpFeeProfile, uint16 buyTaxRate, uint16 sellTaxRate, uint64 taxDuration, uint64 antiFarmerDuration, uint16 mktBps, uint16 deflationBps, uint16 dividendBps, uint16 lpBps, uint256 minimumShareBalance, address dividendToken, address commissionReceiver, uint8 tokenVersion)';

export const PORTAL_ABI = [
  'event TokenBought(uint256 ts, address token, address buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)',
  'event TokenSold(uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)',
  'event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)',
  'event LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth)',
  `function getTokenV8(address token) view returns (${TOKEN_STATE_V8} state)`,
  `function getTokenV8Safe(address token) view returns (${TOKEN_STATE_V8} state)`,
  'function previewBuy(address token, uint256 eth) view returns (uint256 amount)',
  'function previewSell(address token, uint256 amount) view returns (uint256 eth)',
  `function newTokenV6(${NEW_TOKEN_V6_PARAMS} params) payable returns (address token)`,
  ...EXTERNAL_ERRORS,
];

// Variant used only if a deployment ever indexes token/trader (same topic0 — `indexed` is not part of the signature).
export const PORTAL_EVENTS_INDEXED = [
  'event TokenBought(uint256 ts, address indexed token, address indexed buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)',
  'event TokenSold(uint256 ts, address indexed token, address indexed seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)',
];

export const PROVIDER_ABI = [
  'function getModel(uint256 modelId) view returns (tuple(string name, uint256 price, bool enabled) model)',
  'function getRequest(uint256 requestId) view returns (tuple(uint256 requestId, address consumer, uint16 modelId, uint8 numOfChoices, uint64 timestamp, uint128 feePaid, uint8 status, uint8 choice, string reasoningCid) view_)',
  'function getReasoningCid(uint256 requestId) view returns (string)', // named in the integration guide, NOT in IFlapAIProvider.sol — fallback only
  'function maxPromptLength() view returns (uint256)',
  'function callbackGasLimit() view returns (uint256)',
  'function retryUndelivered(uint256 requestId)',
  ...EXTERNAL_ERRORS.filter(e => e.startsWith('error FlapAIProvider')),
];
export const REQUEST_STATUS = ['NONE', 'PENDING', 'FULFILLED', 'UNDELIVERED', 'REFUNDED'];

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function metaURI() view returns (string)',
];

// ---- contracts
export const vaultContract = (runner = getProvider(), addr = addresses().vault) => new Contract(addr, VAULT_ABI, runner);
export const portalContract = (runner = getProvider(), addr = addresses().portal) => new Contract(addr, PORTAL_ABI, runner);
export const providerContract = (runner = getProvider(), addr = addresses().aiProvider) => new Contract(addr, PROVIDER_ABI, runner);
export const erc20 = (addr, runner = getProvider()) => new Contract(addr, ERC20_ABI, runner);

/** $ARBITER address: env ARBITER_TOKEN, else vault.arbiterToken() (null if unset / zero). */
export async function getArbiterToken(vault = vaultContract(), blockTag) {
  const env = addresses().arbiterToken;
  if (env) return env;
  const t = await vault.arbiterToken({ blockTag });
  return t && t !== ZeroAddress ? getAddress(t) : null;
}

// ---- revert decoding across vault + portal + provider ABIs
const _errIface = new Interface([...VAULT_ABI.filter(f => f.type === 'error'), ...EXTERNAL_ERRORS]);
export function decodeRevert(e) {
  if (e?.revert?.name) return `${e.revert.name}(${(e.revert.args || []).map(String).join(',')})`;
  const data = findRevertData(e);
  if (data && data !== '0x') {
    try {
      const d = _errIface.parseError(data);
      if (d) return `${d.name}(${d.args.map(String).join(',')})`;
    } catch {}
    try {
      if (data.startsWith('0x08c379a0')) return 'Error(' + Interface.from(['error Error(string)']).decodeErrorResult('Error', data)[0] + ')';
    } catch {}
    return `revert ${data.slice(0, 74)}`;
  }
  return String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 240);
}
function findRevertData(e, depth = 0) {
  if (!e || depth > 5) return null;
  if (typeof e.data === 'string' && e.data.startsWith('0x')) return e.data;
  if (typeof e.data?.data === 'string') return e.data.data;
  return findRevertData(e.error || e.info?.error || e.cause, depth + 1);
}
