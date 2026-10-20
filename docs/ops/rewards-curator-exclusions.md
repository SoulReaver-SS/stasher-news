# Curator rewards — operator exclusion list

Date: 2026-10-20
Scope: excluding specific accounts from the weekly curator distribution and its
referral commissions without deleting accounts, tips, or historical payouts.

The list is `PlatformFeeConfig.distributionExcludedCuratorIds` (the singleton
row `id = 1`). It is read inside the distribution transaction at run time, so an
edit takes effect on the next weekly run. No worker restart is needed for the
data change itself; a schema migration still follows the normal app + worker
restart convention.

The founder account (`stasher`, user id 616) is always excluded in addition to
this list. An empty list is the default and preserves the founder-only behavior.

## Effect of an exclusion

An excluded account is removed from the final curator attribution before
normalization, ranking, and `topN`. It therefore:

- receives no `RewardPayout` and no `Earn` row;
- consumes no `topN` slot (the next-ranked curator is promoted);
- receives no referral commission as anyone's referrer;
- generates no referral commission for its own referrer;
- has its would-be commission reserved, not redirected: the amount remains in
  `rolledOverPiconeros` and the distribution still reconciles
  `distributedPiconeros + rolledOverPiconeros = poolPiconeros`.

Its tips still count toward item ordering and item weight, matching the existing
founder-account precedent. This list is not a trust-walk exclusion, a ban, or a
posting restriction, and it does not claw back past distributions. Those are
separate features.

## View the current list

```sql
SELECT id, "distributionExcludedCuratorIds"
FROM "PlatformFeeConfig"
WHERE id = 1;
```

## Add an account id

Replace `12345` with the numeric `users.id`. The update deduplicates the list.

```sql
UPDATE "PlatformFeeConfig" SET "distributionExcludedCuratorIds" = (
  SELECT array_agg(DISTINCT v)
  FROM unnest(COALESCE("distributionExcludedCuratorIds", '{}') || ARRAY[12345::int]) AS v)
WHERE id = 1;
```

## Remove an account id

```sql
UPDATE "PlatformFeeConfig"
SET "distributionExcludedCuratorIds" = array_remove(COALESCE("distributionExcludedCuratorIds", '{}'), 12345)
WHERE id = 1;
```

Exact identifier case matters: the column is quoted camelCase
(`"distributionExcludedCuratorIds"`).

## Validation and logging

- Unknown ids and duplicate ids are harmless.
- Non-integer entries, non-positive/out-of-range int4 values, and a non-array
  value are ignored with a worker log error; valid entries in the same array
  still apply. Empty or NULL config behaves exactly like the default.
- Each completed distribution logs `excludedCurators`, the count of active
  exclusions including the founder, alongside the pool/payout totals.
- Edits are forward-only. Rewriting a past distribution's payouts or `Earn`
  rows is not part of this procedure.

## Verification after an edit

```sql
SELECT id, "distributionExcludedCuratorIds"
FROM "PlatformFeeConfig"
WHERE id = 1;
```

Optionally confirm the account id exists before adding it:

```sql
SELECT id, name FROM users WHERE id = 12345;
```
