// Test kit: Solidity mocks of the Flap Portal / AI provider / tokens, compiled with solc, plus ganache helpers.
// Used by scripts/test-candidates.mjs and scripts/test-e2e.mjs. Not used in production.
import solc from 'solc';
import { ethers } from 'ethers';

export const SOURCE = String.raw`
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TToken {
    string public name; string public symbol; string public metaURI; uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
    constructor(string memory n, string memory s, string memory m){ name=n; symbol=s; metaURI=m; }
    function mint(address to,uint256 a) external { balanceOf[to]+=a; totalSupply+=a; }
    function approve(address s,uint256 a) external returns(bool){ allowance[msg.sender][s]=a; return true; }
    function transfer(address to,uint256 a) external returns(bool){ balanceOf[msg.sender]-=a; balanceOf[to]+=a; return true; }
    function transferFrom(address f,address to,uint256 a) external returns(bool){ allowance[f][msg.sender]-=a; balanceOf[f]-=a; balanceOf[to]+=a; return true; }
}

struct TokenStateV8 {
    uint8 status; uint256 reserve; uint256 circulatingSupply; uint256 price; uint8 tokenVersion;
    uint256 r; uint256 h; uint256 k; uint256 dexSupplyThresh; address quoteTokenAddress; bool nativeToQuoteSwapEnabled; bytes32 extensionID;
    uint256 buyTaxRate; uint256 sellTaxRate; address pool; uint256 progress; uint8 lpFeeProfile; uint8 dexId;
}
struct ExactInputParams { address inputToken; address outputToken; uint256 inputAmount; uint256 minOutputAmount; bytes permitData; }
struct Trade { address token; bool buy; uint256 eth; }

/// Flap Portal mock. Events have the exact IPortal.sol signatures (no indexed args).
contract TPortal {
    struct S { uint8 status; address quote; uint256 progress; uint256 price; uint8 version; }
    mapping(address=>S) public st;
    event TokenBought(uint256 ts, address token, address buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice);
    event TokenSold(uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice);
    event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta);

    function set(address t, uint8 status, address quote, uint256 progress, uint256 price) public { st[t] = S(status, quote, progress, price, 6); }
    function setVersion(address t, uint8 v) external { st[t].version = v; }
    function setPrice(address t, uint256 price) external { st[t].price = price; }
    function setProgress(address t, uint256 p) external { st[t].progress = p; }

    function emitTrades(Trade[] calldata ts) external {
        for (uint256 i = 0; i < ts.length; i++) {
            if (ts[i].buy) emit TokenBought(block.timestamp, ts[i].token, msg.sender, 1e18, ts[i].eth, ts[i].eth / 100, 1);
            else emit TokenSold(block.timestamp, ts[i].token, msg.sender, 1e18, ts[i].eth, ts[i].eth / 100, 1);
        }
        emit TokenCreated(block.timestamp, msg.sender, 1, address(this), "decoy", "DECOY", "cid"); // not a trade
    }

    function getTokenV8(address t) external view returns (TokenStateV8 memory s) {
        S memory x = st[t];
        s.status = x.status; s.quoteTokenAddress = x.quote; s.progress = x.progress; s.price = x.price; s.tokenVersion = x.version;
    }
    function getTokenV8Safe(address t) external view returns (TokenStateV8 memory s) {
        S memory x = st[t];
        s.status = x.status; s.quoteTokenAddress = x.quote; s.progress = x.progress; s.price = x.price; s.tokenVersion = x.version;
    }
    struct QuoteExactInputParams { address inputToken; address outputToken; uint256 inputAmount; }
    function quoteExactInput(QuoteExactInputParams calldata q) external view returns (uint256) { return q.inputToken == address(0) ? previewBuy(q.outputToken, q.inputAmount) : previewSell(q.inputToken, q.inputAmount); }
    function previewBuy(address t, uint256 eth) public view returns (uint256) { return eth * 1e18 / st[t].price; }
    function previewSell(address t, uint256 amt) public view returns (uint256) { return amt * st[t].price / 1e18; }
    function swapExactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        if (p.inputToken == address(0)) {
            out = previewBuy(p.outputToken, msg.value); require(out >= p.minOutputAmount, "slip");
            TToken(p.outputToken).mint(msg.sender, out);
            emit TokenBought(block.timestamp, p.outputToken, msg.sender, out, msg.value, 0, st[p.outputToken].price);
        } else {
            out = previewSell(p.inputToken, p.inputAmount); require(out >= p.minOutputAmount, "slip");
            TToken(p.inputToken).transferFrom(msg.sender, address(this), p.inputAmount);
            (bool ok,) = msg.sender.call{value: out}(""); require(ok, "pay");
            emit TokenSold(block.timestamp, p.inputToken, msg.sender, p.inputAmount, out, 0, st[p.inputToken].price);
        }
    }
    receive() external payable {}
}

/// Same events but with token/trader indexed — proves the decoder copes if Flap ever indexes them.
contract TPortalIndexed {
    TPortal public base;
    constructor(TPortal b) { base = b; }
    event TokenBought(uint256 ts, address indexed token, address indexed buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice);
    event TokenSold(uint256 ts, address indexed token, address indexed seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice);
    function emitTrades(Trade[] calldata ts) external {
        for (uint256 i = 0; i < ts.length; i++) {
            if (ts[i].buy) emit TokenBought(block.timestamp, ts[i].token, msg.sender, 1e18, ts[i].eth, 0, 1);
            else emit TokenSold(block.timestamp, ts[i].token, msg.sender, 1e18, ts[i].eth, 0, 1);
        }
    }
    function getTokenV8(address t) external view returns (TokenStateV8 memory) { return base.getTokenV8(t); }
}

/// Just the two vault views candidates.js needs.
contract TVaultView {
    mapping(address=>bool) public holding; address public arbiterToken;
    function setHolding(address t, bool h) external { holding[t] = h; }
    function setArbiterToken(address t) external { arbiterToken = t; }
}

interface IConsumer { function fulfillReasoning(uint256, uint8) external; function onFlapAIRequestRefunded(uint256) external payable; }

/// Flap AI provider mock with the published IFlapAIProvider view surface.
contract TProvider {
    struct Model { string name; uint256 price; bool enabled; }
    struct RequestView { uint256 requestId; address consumer; uint16 modelId; uint8 numOfChoices; uint64 timestamp; uint128 feePaid; uint8 status; uint8 choice; string reasoningCid; }
    uint256 public price = 0.05 ether; uint256 public n; string public lastPrompt;
    mapping(uint256=>RequestView) internal reqs;
    function getModel(uint256) external view returns (Model memory m) { m.name = "anthropic/claude-sonnet-4.6"; m.price = price; m.enabled = true; }
    function maxPromptLength() external pure returns (uint256) { return 4096; }
    function callbackGasLimit() external pure returns (uint256) { return 1000000; }
    function reason(uint256 modelId, string calldata prompt, uint8 k) external payable returns (uint256) {
        require(msg.value >= price, "fee"); n++; lastPrompt = prompt;
        reqs[n] = RequestView(n, msg.sender, uint16(modelId), k, uint64(block.timestamp), uint128(msg.value), 1, 0, "");
        return n;
    }
    function fulfill(uint256 id, uint8 choice, string calldata cid) external {
        RequestView storage r = reqs[id]; r.choice = choice; r.reasoningCid = cid;
        try IConsumer(r.consumer).fulfillReasoning{gas: 1_000_000}(id, choice) { r.status = 2; } catch { r.status = 3; }
    }
    function getRequest(uint256 id) external view returns (RequestView memory) { return reqs[id]; }
    receive() external payable {}
}
`;

let _compiled;
export function compile() {
  if (_compiled) return _compiled;
  const input = {
    language: 'Solidity',
    sources: { 'T.sol': { content: SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
  _compiled = {};
  for (const [name, c] of Object.entries(out.contracts['T.sol'])) _compiled[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  return _compiled;
}

export async function deploy(signer, art, ...args) {
  const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

let pass = 0, fail = 0;
export function ok(cond, msg) { if (cond) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } }
export function eq(a, b, msg) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, s ? msg : `${msg}\n         got ${JSON.stringify(a)}\n         want ${JSON.stringify(b)}`); }
export function done() { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1); }

// Fixed ganache keys so tests can hand KEEPER_PK to the handlers.
export const KEYS = [
  '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32), '0x' + '44'.repeat(32),
];
export const ganacheAccounts = () => KEYS.map(k => ({ secretKey: k, balance: '0x' + (10n ** 24n).toString(16) }));
