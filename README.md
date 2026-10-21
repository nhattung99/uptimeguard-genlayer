# UptimeGuard

UptimeGuard escrows one hosting or API period fee in a single GenLayer Intelligent Contract. The customer locks the fee in GEN. The provider must accept the terms. After the period, the customer can file a claim with evidence and at least two reference sources. AI consensus (`gl.vm.run_nondet`) returns exactly one of two results: `SLA_MET` or `SLA_BREACHED`. The refund is a fixed amount both parties agreed in advance. Validators compare it with absolute equality (`==`). There is no percentage tolerance on the money.

> UptimeGuard dies without GenLayer: no EVM smart contract can read unstructured incident history on status pages and monitors, compare it with a natural-language SLA, and stay cheap enough for a small hosting or API contract. Only GenLayer's decentralized AI consensus can do that at near-zero cost.

**Network:** Studionet only.

Free to use — you only pay GenLayer network gas when you sign a transaction. There is no other platform fee.

## Live App

https://uptimeguard-genlayer.vercel.app

## Deployed Contract

Deployed on GenLayer Studionet with `Result: SUCCESS`.

- **Address:** `0xB71F31BC1Ca3a772E7c89604871D5818bC8EbA3D`
- **Explorer:** https://genlayer-explorer.vercel.app/address/0xB71F31BC1Ca3a772E7c89604871D5818bC8EbA3D

```env
VITE_CONTRACT_ADDRESS=0xB71F31BC1Ca3a772E7c89604871D5818bC8EbA3D
```

If that variable is empty, the frontend still opens: a warning banner says the address is missing, the fee preview still works, signing stays locked, and the page does not go blank.

## Problem

A customer pays a monthly fee to a small hosting or API provider, with an uptime promise attached. When something breaks, the provider usually measures the outage and decides the refund itself. The two sides have no cheap, fast, neutral referee for a small contract.

UptimeGuard holds the period fee in the contract:

1. The customer creates an agreement: provider address, service description, SLA terms, a fixed refund (`0 < breach_refund_amount < fee_amount`), period end, and a claim window. The GEN attached to the transaction is `fee_amount`.
2. The provider calls `accept_agreement` before the period ends. Otherwise the customer calls `cancel_unaccepted` and receives the full fee back.
3. Inside `[period_end, claim_deadline]`, the customer submits at least 1 evidence link and 2 reference links.
4. Anyone can call `resolve_claim`. The AI compares the terms with the pages it read.
5. `confidence < 60` sets `DISPUTED`. The customer can refile until `stale_deadline`.
6. If the claim window closes while the agreement is still `ACTIVE`, anyone can call `settle_unclaimed` and the provider receives the full fee.
7. If the dispute window closes while the agreement is still `DISPUTED`, anyone can call `settle_stale_dispute` and the provider receives the full fee.

The burden of proof is on the customer. Insufficient, contradictory, or untimestamped evidence resolves as `SLA_MET`. That design leans toward the provider.

## Architecture

One contract, [`contracts/uptime_guard.py`](contracts/uptime_guard.py), holds the GEN directly. There is no second contract and no value forwarded through a cross-contract call.

Studio header:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

| Job | API |
|---|---|
| Caller | `gl.message.sender_address` |
| Send GEN | `gl.get_contract_at(address).emit_transfer(value=u256(amount))` |
| Receive GEN when the agreement is created | `@gl.public.write.payable`, then read `gl.message.value` |
| Time | `gl.message_raw["datetime"]` (ISO-8601), then `gl.message.datetime`, then `datetime.now`, which GenVM pins to the transaction timestamp |
| Map | `TreeMap.get(key, default)` when a default is needed |

`@gl.public.write.payable` exists in `genlayer/gl/annotations.py` for this hash. The runner rejects a non-zero value on a non-payable method (`called non-payable method ... with non-zero value`). `create_agreement` therefore uses `.payable`. The older note that the payable decorator does not exist is wrong for this SDK.

`gl.vm.Return` in this SDK stores the leader result on `.calldata`. There is no `.value`. The validator compares `verdict` with `==` and requires both sides to land on the same side of `confidence >= 60`, so two validators cannot both say `SLA_MET` while one settles and the other leaves the claim `DISPUTED`.

`DynArray()` cannot be constructed (`this class can't be instantiated by user`). Empty URL lists are stored as `[]`; storage coerces them to `DynArray`.

## Resolve flow

```
PENDING_ACCEPTANCE
  ├─ accept_agreement (before period_end) → ACTIVE
  └─ cancel_unaccepted → CUSTOMER_FULL → CANCELLED_REFUNDED

ACTIVE
  ├─ file_claim inside [period_end, claim_deadline] → CLAIM_FILED
  └─ after claim_deadline: settle_unclaimed → PROVIDER_FULL → SETTLED_NO_CLAIM

CLAIM_FILED
  └─ resolve_claim
       ├─ confidence < 60 → DISPUTED
       ├─ SLA_MET → PROVIDER_FULL → RESOLVED_SLA_MET
       └─ SLA_BREACHED → SPLIT_BREACH → RESOLVED_SLA_BREACHED

DISPUTED
  ├─ file_claim again before stale_deadline → CLAIM_FILED
  └─ after stale_deadline: settle_stale_dispute → PROVIDER_FULL → SETTLED_STALE_DISPUTE

PAYOUT_FAILED → retry_resolution (does not re-run the AI; pays only the missing side)
```

Deadlines:

- `claim_deadline = period_end + claim_window_seconds`
- `stale_deadline = claim_deadline + claim_window_seconds`
- The claim window is the closed interval `[period_end, claim_deadline]`
- `settle_unclaimed` only when `now > claim_deadline`
- `settle_stale_dispute` only when `now > stale_deadline`

Every transfer goes through `_settle(kind, success_status)`. The payout kind is stored **before** the transfer: `PROVIDER_FULL`, `SPLIT_BREACH`, or `CUSTOMER_FULL`. The flags `provider_paid` and `customer_refunded` keep `retry_resolution` from paying the same side twice.

On `SLA_BREACHED`, the provider receives `fee - breach_refund_amount` and the customer receives exactly `breach_refund_amount`.

## Honest limits

1. Only incidents **recorded in public** can be checked. If the provider never publishes an incident and no monitor or archive recorded it, there is nothing to compare.
2. The provider **controls its own status page** and can omit or delete incidents. A real independent source is a third-party monitor or a timestamped archive. The UI tells the customer to prefer those sources.
3. An LLM can misread total downtime from incident logs. SLA terms should stay simple and objective (a concrete downtime threshold), not a complex formula.
4. The rule "insufficient evidence → `SLA_MET`" leans toward the provider (the burden-of-proof design).
5. Many status pages render with JavaScript or block automated access, so `web.render` may not be able to read them. Some popular status services expose a public data endpoint; **check that in practice, do not assume it**. An unreadable page reverts the transaction, and the call can be retried.
6. The contract only holds the fee and adjudicates. **The service itself happens off-chain** and the contract cannot control it.
7. The prompt-injection defense only reduces risk.
8. Each agreement covers **one period**. The next period needs a new agreement.

### Status pages checked with HTTP GET (21 Oct 2026)

These are ordinary GETs, not `gl.nondet.web.render` on Studionet. `web.render` can only be checked with a real resolve transaction after the contract is deployed.

| URL | HTTP | Note |
|---|---|---|
| `https://www.githubstatus.com/api/v2/summary.json` | 200 `application/json` | Statuspage summary, includes `updated_at`. A good reference URL. |
| `https://www.cloudflarestatus.com/api/v2/summary.json` | 200 `application/json` | Same kind of JSON summary. |
| `https://www.githubstatus.com/` | 200 `text/html` | HTML shell. Incident text may appear only after JavaScript, so `web.render` may or may not read it. |
| `https://status.aws.amazon.com/` | 200 `text/html` | More static HTML. Still not confirmed with `web.render`. |

Prefer a JSON URL or a timestamped archive. If `web.render` cannot read a URL, `resolve_claim` reverts and can be called again.

## Money handling

Every amount is an integer number of wei (`1 GEN = 10^18`). There is no `float`, `parseFloat`, `Math.round`, `Math.floor`, or `Math.ceil` on the money path.

| # | Place | File | Write or read | How | Unit |
|---|---|---|---|---|---|
| 1 | Period fee attached at creation | `create_agreement` ← `gl.message.value` | WRITE `fee_amount` | `bigint(gl.message.value)` | wei |
| 2 | Fixed refund | `create_agreement` argument | WRITE `breach_refund_amount` | `bigint`, constrained to `0 < x < fee` | wei |
| 3 | Provider receives the full fee | `_execute_settlement` `PROVIDER_FULL` | READ `fee_amount` | `emit_transfer(value=u256(fee))` | wei |
| 4 | Split when the SLA is breached | `_execute_settlement` `SPLIT_BREACH` | READ both | provider `fee - refund`, customer `refund` | wei |
| 5 | Customer receives the full fee | `_execute_settlement` `CUSTOMER_FULL` | READ `fee_amount` | `emit_transfer` to the customer | wei |
| 6 | Retry the missing side | `retry_resolution` | READ `provider_paid` / `customer_refunded` and the stored `settlement_kind` | does not recompute and does not re-run the AI | wei |
| 7 | GEN input | `frontend/src/money.js` `sanitizeGenInput` | WRITE the input string | digits and one `.`, at most 18 fractional digits | GEN string |
| 8 | GEN → wei before signing | `parseGenToWei` | WRITE the transaction `value` and `breach_refund_amount` | integer part plus 18 fractional digits as `BigInt` | wei |
| 9 | 25% / 50% / 75% chips | `percentOfWei` | WRITE the suggested refund | `fee * pct / 100n`, integer division | wei |
| 10 | Preview before signing | `computeBreachPreview` | READ | customer = refund, provider = `fee - refund` | wei |
| 11 | Display a balance or payout | `formatWeiToGen` | READ | `wei / 10^18` with `BigInt` | GEN string |
| 12 | Three payout kinds in the UI | `settlementShares` | READ `settlement_kind`, fee, refund | same formula as the contract | wei |
| 13 | `value` sent to MetaMask | `toValueBigInt` | WRITE | `bigint` or hex string → `BigInt`; a JS `number` becomes `0n` | wei |
| 14 | Field read from the contract | `toWeiString` | READ | digit strings only; `typeof number` → `"0"` so a large wei value is not swallowed | wei string |
| 15 | Float gate at build | `scripts/check-no-float-money.js`, wired to `prebuild` | — | fails if `parseFloat` / `Math.round` / `floor` / `ceil` sits near `fee\|refund\|amount\|payout\|balance\|wei\|gen` | — |

## Tests

```bash
pip install -r requirements.txt
pytest tests/test_uptime_guard.py -q
```

Before every nondet transaction, the tests call `sim_installMocks` (and `mock_web` / `mock_llm`). Time moves by replacing `_current_unix_timestamp`.

`emit_transfer` is spied by recipient. The spy can force the provider, the customer, or both to throw.

Frontend:

```bash
cd frontend
npm install
npm run test:money
npm run build
```

`npm run build` runs `prebuild` → `frontend/scripts/check-no-float-money.cjs`. The repo-root copy at `scripts/check-no-float-money.js` scans the same sources. The frontend copy uses `.cjs` because `frontend/package.json` is `"type": "module"`.

## Deploy the contract on Studionet

1. Open [GenLayer Studio → Run & Debug](https://studio.genlayer.com/run-debug).
2. Paste `contracts/uptime_guard.py` and keep the two header lines.
3. Deploy. Open the transaction and confirm **`Result: SUCCESS`**.
4. Set `VITE_CONTRACT_ADDRESS` in `frontend/.env` and on Vercel.

The deployed address is in **Deployed Contract** above. Do not switch the network.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. The chain is `studionet` from `genlayer-js/chains`. The wallet needs GEN from Studio → Accounts.

SLA terms come from presets that generate a fixed English sentence. An "Other terms" field is available. Periods of 7, 30, or 90 days and claim windows of 3, 7, or 14 days compute `period_end` and `claim_window_seconds`. Fee chips and 25/50/75% refund chips use `BigInt`. The preview states what each side receives if the SLA is breached and if it is not.

On the claim step, the UI asks for an independent monitor or a timestamped archive. Evidence that is not clear enough is treated as the SLA being met.
