# Rewards payout size recovery — operator runbook

Date: 2026-10-19
Scope: recovering whole rewards payouts left QUEUED/FAILED by the rewards hot
wallet's transaction-size limit or fragmented inputs.

This is an operator-owned, explicitly confirmed procedure. There is no new
retry job, no scheduled resume, no automatic delayed retry, and no new CLI flag.
Never split one `RewardPayout` across transactions, change Earn rows, or change
`distributedPiconeros` / `rolledOverPiconeros` during delivery recovery.

Use the environment's normal loader and secret injection. The local/dev commands
below are examples; production must preserve the existing deployment's
loader wrapper instead of pasting dev commands. Never print keys, seed words,
signed transaction material, or wallet objects. Log only the code-owned reason,
stage, distribution ID, source account, payout IDs, hashes, and numeric amounts.

## 1. Confirm the deployed worker and inspect the facts

Before touching state, confirm the worker revision includes chunked delivery,
the no-QUEUED completion/accounting gate, and targeted fragmented-inputs
recovery. Confirm the running code emits the fixed reasons `transaction-size`
and `fragmented-inputs`; never infer recovery from a generic exception message.

Inspect, read-only:

- the distribution's `id`, `status`, `periodStart`/`periodEnd`, allocation
  totals, and completion timestamps;
- every payout's `id`, `state`, `txHash`, amount, and recipient; identify
  `FAILED` rows with a NULL hash (provably pre-relay) separately from `FAILED`
  rows with a hash (wallet-history reconciliation owns those — never requeue
  them blindly);
- the scoped rewards-wallet journal (`network` + `walletAddress`) for this
  distribution and for consolidations: kind, state, account index, exact hash,
  proof ID, principal, real fee, attempt/relay timestamps;
- wallet evidence from the existing wallet tooling: unlocked and total balance
  per signer account, plus outgoing transfers by exact hash, destination, and
  real fee.

Do not expose the wallet address, keys, proof ciphertext, or signed material in
tickets or chat. A journal/proof pair is the durable record of an attempt; do
not delete, edit, or replace it.

## 2. Confirm no sender is live

A `SENDING` distribution may be mid-relay. Do not override `SENDING` and do not
manually fail it or bypass the 24-hour stale-SENDING watchdog to accelerate
recovery. Wait for the sender to settle, wait for the watchdog with independent
evidence that the old process is gone, or stop and reconcile the exact attempt.
A queue row that merely looks failed is not proof that its handler stopped.

## 3. Dry-run first

Use the environment's normal loader/secret injection. In local/dev:

```bash
./sndev monero requeue 7
```

The dry run reports candidates and refused `FAILED` rows that already have a
hash. When there are no FAILED candidates, it also reports whether QUEUED rows
are present (a later confirm+send can drive those); it does not print a QUEUED
count alongside a non-empty candidate list. The dry run must not mutate
payout/distribution state and must not open a wallet or invoke the signer.
Compare its candidates with the Step 1 facts before continuing. If the output is
not exactly the expected pre-relay rows, stop.

## 4. Confirmed recovery (separate operator authorization required)

Only after a separate authorization for this specific distribution:

```bash
./sndev monero requeue 7 --confirm
```

This flips only `FAILED` + NULL-hash rows to QUEUED inside the guarded
transaction and drives the normal completion path. It refuses `SENDING`, never
touches Earn rows or allocation totals, and is idempotent on QUEUED rows.
Refused `FAILED`-with-hash rows stay outside this tool.

If the distribution was already `COMPLETE` while still holding stranded rows
(the masked-completion shape), confirmed recovery first unmasks it from
`COMPLETE` to `FAILED` and clears `completedAt` so the normal finalize CAS can
resume delivery. This status unmask is existing recovery behavior; it does not
rewrite payouts, Earn rows, allocation totals, or allocation rules.

## 5. Direct launcher and production wrapper

For an appropriately configured direct launcher, the existing equivalent is:

```bash
npx tsx --tsconfig jsconfig.json scripts/requeue-failed-payouts.js 7
```

Adding `--confirm` mutates state and can relay:

```bash
npx tsx --tsconfig jsconfig.json scripts/requeue-failed-payouts.js 7 --confirm
```

On production, use the deployment's existing loader wrapper and wallet/secret
injection rather than pasting these dev commands. `--no-send` is ledger-only:
it flips eligible rows but never opens a wallet; a later confirmed send-capable
run must deliver them.

## 6. If recovery consolidates, wait for real unlocks and resume explicitly

Targeted recovery may relay a zero-principal self-consolidation for the
fragmented source so a later send has usable outputs. If it does:

- inspect every distinct consolidation journal/proof pair, exact transaction
  hash, source account, and the sum of real fees; there is no synthetic fee;
- wait until the wallet reports the actually relayed recovery outputs unlocked;
- then explicitly resume with the same confirmed command from Step 4/5.

A ten-block lock is not a guaranteed twenty-minute timer. Confirmation and
unlock timing can vary; a fixed wait is not evidence. There is no new scheduled
resume and no automatic retry after consolidation. A successful ordinary send
may also lock its change and require another explicit resume.

Consolidation is not triggered merely by having 364 outputs, nor by a transient
shortage of unlocked funds. It is authorized only after a recognized
transaction-size rejection leaves whole payouts fragmented and the bounded
history/usefulness gates pass.

## 7. Stop conditions

Stop and reconcile before any further spend when any of these is observed:

- an attempted-but-unproven relay (the journal has an attempt that is not
  proven relayed, or the wallet outcome is uncertain);
- a reserved `PREPARED` journal/proof pair;
- an unreadable or contradictory journal;
- a repeated singleton transaction-size failure after a durable recovery cycle;
- an unexpected amount, destination, fee, or aggregate;
- inadequate recovered value (fees/shortage leave no whole payout coverable).

For an uncertain attempt, first resolve the exact existing journal/reservation
through the existing verification flow. Only after that, wait for ANY actually
relayed recovery outputs to unlock, and only then resume payouts. Never send a
manual replacement payment, never blindly resend, and never delete journal or
proof rows or tear down the attempt.

## 8. Acceptance checks

Do not call recovery complete until all of these hold:

- every intended payout is `SENT`/`CONFIRMED` exactly once, with exactly one
  recorded hash per payout. Payouts relayed in the same batch transaction
  legitimately share that transaction hash; no payout may appear in two
  transactions, and no duplicate or replacement transaction may exist;
- for the reported incident, recipient principal still totals exactly
  629810734186 piconeros across the intended payouts;
- every real transaction fee is represented by the scoped journal, and any
  consolidation has distinct journal/proof pairs and real fee facts;
- Earn rows, `distributedPiconeros`, `rolledOverPiconeros`, payout count, and
  allocation rules are unchanged by recovery;
- an incomplete or unresolved run did not schedule an ops sweep;
- an older recovered distribution does not become eligible for the latest-only
  ops sweep merely by completing — eligibility still requires the latest
  distribution, all payouts settled, and no proven sweep;
- repeating the confirmed command after successful delivery invokes no signer
  and mutates nothing.

## Fixed log reasons

- `reason: transaction-size` — the signer recognized its exact
  transaction-too-large rejection. The whole payout stays QUEUED, never
  terminal FAILED. Normal batches are chunked/bisected; a payout that still
  fails alone is fragmented and needs the bounded targeted path or operator
  intervention.
- `reason: fragmented-inputs` — a targeted recovery decision for one
  distribution/source-account pair. The accompanying fixed `stage` says whether
  a consolidation was relayed or withheld (for example dust, unaffordable,
  empty, reserved, exhausted, history-unavailable, preparation, claim,
  relay-uncertain, journal-state, sweep-failed). It is not permission to resend
  or delete anything; use the stage-specific inspection above.
