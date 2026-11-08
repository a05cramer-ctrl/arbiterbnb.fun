# ARBITER backend

Vercel serverless functions + scripts for $ARBITER (Flap tax token on BNB Chain). The vault contract lives in `../contracts`.

| path | what |
|---|---|
| `api/stats.js` | GET, everything the site shows, read from the vault (CDN `s-maxage=20`) |
| `api/candidates.js` | GET, the ten coins the public rule picks right now (`s-maxage=60, swr=120`, CORS `*`) |
| `api/tick.js` | keeper: closes exits, retries undelivered oracle callbacks, asks once an hour. `?dry=1` simulates |
| `api/_lib/candidates.js` | **the public rule** (reference implementation, shared with the verify script) |
| `api/_lib/chain.js` | provider, addresses, ABIs, revert decoding |
| `api/_lib/vault-abi.json` | copy of `contracts/out/ArbiterVault.json` (abi + bytecode). Re-copy after recompiling |
| `scripts/deploy-vault.mjs` | deploy ArbiterVault, writes `deployments.json` |
| `scripts/launch-token.mjs` | upload meta, mine a …7777 salt, `Portal.newTokenV6` (TOKEN_TAXED_V3, 3%/3% to vault), `vault.setArbiterToken` |
| `scripts/verify-candidates.mjs` | recompute the ten for any past round: `--round N` or `<askedAt>` |
| `scripts/test-candidates.mjs`, `scripts/test-e2e.mjs` | ganache tests (`npm test`) |

## Env

| var | |
|---|---|
| `BSC_RPC` | **Use a getLogs-capable RPC** (NodeReal, Ankr, QuickNode, Chainstack…). Public `bsc-dataseed` nodes often refuse or cap `eth_getLogs`. For `verify-candidates` on old rounds it must also serve historical state (archive). Default `https://bsc-dataseed.bnbchain.org` |
| `VAULT_ADDRESS` | required for stats/tick (stats returns `{live:false}` without it) |
| `ARBITER_TOKEN` | optional, else `vault.arbiterToken()` |
| `KEEPER_PK` | keeper wallet (must equal `vault.keeper()`); keep ~0.05 BNB in it for gas |
| `CRON_SECRET` | required for `/api/tick` (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; manual: `?key=`) |
| `LOGS_CHUNK` | blocks per getLogs call, default 3000 (an hour is ~8000 blocks at 0.45s). Failing chunks are split automatically |
| optional | `CHAIN_ID` (56/97), `PORTAL`, `AI_PROVIDER`, `PANCAKE_V2_ROUTER`, `LOGS_CONCURRENCY` (4), `RPC_CONCURRENCY` (8), `RPC_BATCH` (1 = no JSON-RPC batching), `RPC_TIMEOUT_MS`, `GAS_PRICE_GWEI` (force legacy gas price), `TOPIC_BOUGHT`/`TOPIC_SOLD` (override event topic0), `IPFS_GATEWAY` (default `https://flap.mypinata.cloud/ipfs/`), `BLOCK_TIME_HINT` (0.45) |
| scripts | `DEPLOYER_PK` (vault owner) |

**Cron:** `vercel.json` runs `/api/tick` every 5 minutes. Per-5-minute crons need **Vercel Pro**. On Hobby, use a free external cron (cron-job.org etc.) to GET `https://<site>/api/tick?key=<CRON_SECRET>` every 5 minutes.

## The rule (exact)

Window `[M-3600, M)` by block timestamp, `M` = start of the minute of the chain head when the keeper computes the list. Volume = sum of `eth` over all Portal `TokenBought` + `TokenSold` events in that range. Keep coins with `getTokenV8`: `status == Tradable`, `quoteTokenAddress == 0x0`, `progress < 0.9e18`, enum fields the vault can decode; drop $ARBITER and `vault.holding(token)`. Order: volume desc, then address asc. First ten. The vault's own trades count as volume like anyone's. `verify-candidates --round N` reads state at the block before the ask and tries minute `M`, then `M-60`.

## Launch order

1. **Testnet (chain 97)**: `node scripts/deploy-vault.mjs --testnet` → `node scripts/launch-token.mjs --testnet --dry` (check the simulation line) → real launch → set Vercel env with `CHAIN_ID=97` + testnet `BSC_RPC` → `/api/tick?dry=1&key=…` → fund the vault (> 0.03 BNB + the oracle fee) → one real tick.
   Confirm: (a) a trade of the test token makes the vault's `receive()` fire (`TaxIn` event, `totalTaxIn` rises). Flap's tax processor pushes BNB to the beneficiary; it's unconfirmed that a plain contract works as a newTokenV6 beneficiary, and how much gas the push forwards. (b) One oracle round end to end: `Asked` → `Picked` → `Bought` (or `BuyFailed`), and the reasoning CID in `/api/stats`. Testnet oracle fulfilment runs on a limited budget and may not answer. The testnet Portal is v5.8.5 (mainnet v5.23.1), so newTokenV6/TOKEN_TAXED_V3 may not exist there. If the simulation reverts, test the tax flow on mainnet with a throwaway token instead.
2. **Mainnet**: same steps without `--testnet`. Then `vercel env add` VAULT_ADDRESS / KEEPER_PK / CRON_SECRET / BSC_RPC, deploy, and watch `/api/tick?dry=1&key=…`.

## First live run checklist (unverified assumptions)

- [x] Event signatures: `TokenBought/TokenSold(uint256 ts,address token,address trader,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)`, **no indexed args**. Topic0 checked against a compile of the real `IPortal.sol`. Still check that `/api/candidates` shows non-zero volumes. The decoder also handles an indexed variant.
- [ ] `eth` in trade events: is it gross (incl. fee) or net? Either way it's what the rule sums; just be consistent.
- [ ] RPC getLogs limits: watch `scan.getLogsCalls` / `ms` in `/api/candidates`; tune `LOGS_CHUNK`.
- [ ] Reasoning CID: the provider has **no `getReasoningCid`** in its published interface. We read `getRequest(id).reasoningCid` and only fall back to `getReasoningCid`. Check `rounds[0].cid` after the first answer.
- [ ] Tax arrives as BNB (not WBNB). The keeper calls `vault.unwrap()` automatically if WBNB shows up.
- [ ] `receive()` gas: it does an SSTORE plus an event (~25k gas). If the tax processor pushes with a 2300 stipend, tax will fail. Watch for `TaxLiquidationError` on the token or tax piling up in the processor.
- [ ] Callback gas: `fulfillReasoning` buys on the curve inside the callback. Check `provider.callbackGasLimit()` (dry tick prints it, docs say ≥1M) against the real Portal buy gas. On mock, ask() used ~1.6M gas, mostly the mock storing the prompt.
- [ ] Prompt length vs `provider.maxPromptLength()` (printed by dry tick). The prompt is ~1.1 KB.
- [ ] Tool name: the vault prompt says `ave_token_tool`; the docs' interface comments call it `ave_token_info`. The prompt is baked into the contract.
- [ ] Vanity/CREATE2: the launch script simulates `newTokenV6` and aborts unless the returned address equals the prediction. Tax Token V3 impl from the docs: mainnet `0x024f18294970B5c76c0691b87f138A0317156422`, testnet `0xE6Ff967a887084c16D0fD71548CF709542cc1557`.
- [ ] `antiFarmerDuration`: the default is 3600 (docs example). The Portal has `AntiFarmerDurationTooShort`, so 0 may revert. `taxDuration` = 100×365 days.
- [ ] `funcs.flap.sh/api/upload`: field names come from the docs example (`website, twitter, telegram, description, creator`). Missing ones are sent as null.
- [ ] `getTokenV8` enum decoding in the vault: a coin with a token version > 7 would make `ask()` revert. We filter those out, but positions can't be affected (see contract notes).

## Decisions made

- The window ends at a minute boundary, so the list is reproducible from `askedAt`.
- The keeper uses chain time (head block), not server time.
- The scan doesn't stop at the top 25. It keeps checking by volume until it has ten or has checked `CANDIDATE_MAX_CHECK` (400) coins, because USD-quoted coins report huge `eth` numbers and can crowd the top.
- Each tx is preceded by a staticCall, so reverts come back as decoded custom-error names (vault + Portal + provider errors). Gas is estimated +30%.
- If the oracle callback is `UNDELIVERED`, the tick calls `provider.retryUndelivered(id)`, which anyone may call.
- `dexThresh` = FOUR_FIFTHS (the docs give no recommendation; their tax example uses TWO_THIRDS). Metadata `creator` = zero address, as in the docs.
- The ethers request cache is disabled, so back-to-back keeper txs always get fresh nonces.
