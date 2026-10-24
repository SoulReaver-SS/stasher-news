#!/usr/bin/env bash
# One-shot dev-DB cleanup of residue left by the real-DB integration tests
# (test/worker/rewardsDistributor.test.js and the RUN_STAGENET_INTEGRATION=1
# suite test/integration/rewards-distribution-stagenet.test.js). Interrupted
# runs (killed process, container restart, beforeAll throw) skip their afterAll
# teardown, leaving CONFIRMED FeeObservation/ObservedTip/ObservedDownvote rows,
# RewardDistribution/Earn/RewardPayout rows, MoneroAccounts and empty-name test
# users behind — which inflates (or, once a test distribution exists, zeroes)
# the /rewards pool display.
#
# Run after any test-suite run that left residue behind:
#   ./scripts/clean-rewards-test-residue.sh
#
# Idempotent: safe to re-run on a clean DB (deletes nothing). Deletes ONLY
# test-identifiable rows:
#   * observations with test txHash prefixes (rdfee / rdtip / rddv /
#     dist-test-tip- / dist-test-downvote- / cs / cf — curatorShares and
#     confirmFinalizer fixtures)
#   * distributions: the test's "prior" shape (1e12 pool, 0 distributed,
#     COMPLETE), any distribution with a fake-sent payout (txHash = 'ab'*32,
#     the test signer), and any distribution whose Earn/payouts reference test
#     (empty-name) users — real distributions reference named users
#   * orphan Earn rows (distributionId IS NULL)
#   * MoneroAccounts: the makeAddress signature (address ends in 90 'A's),
#     accounts referenced by test tips, accounts owned by test users
#   * bounty residue: BountyPayment rows won by test (empty-name) users, paid
#     out of their items, or carrying 'btest*' fixture hashes — plus their
#     escrow journal rows (EscrowWalletTransaction) and proofs — and
#     ObservedBounty rows on test users' items / test accounts ('uf-*'
#     txHashes, 'obtest*' paymentIds)
#   * users with NULL name (created by the tests via INSERT ... DEFAULT VALUES)
#     and their remaining PayIns/Items
# REAL rows are never matched by these patterns (verified against the dev DB).
# If a real distribution ever runs (cron, Monday 00:00 UTC), its payouts carry
# real tx hashes and its Earn references named users, so it is NOT deleted.
set -euo pipefail

docker exec -i db psql -U sn -d stackernews <<'SQL'
\set ON_ERROR_STOP on
BEGIN;

-- Test users: empty-name (the tests insert users with DEFAULT VALUES).
CREATE TEMP TABLE _tu AS SELECT id FROM users WHERE name IS NULL;

-- PayIns referenced by the rdfee fixtures (capture before deleting the fees).
CREATE TEMP TABLE _fee_payins AS
  SELECT DISTINCT "payInId" AS id FROM "FeeObservation" WHERE "txHash" LIKE 'rdfee%';

-- Recipient accounts referenced by test tips (capture before deleting tips):
-- the test txHash prefixes, plus any account owned by a test (empty-name)
-- user — a test-created tip may carry a random-looking txHash, so the
-- recipient-account ownership is the reliable test signal. Real accounts are
-- owned by named users and are never matched here. The cs/cf prefixes cover
-- the curatorShares and confirmFinalizer live-DB fixtures ('cs'/'cf' + digits
-- — impossible in real 64-char hex tx hashes).
CREATE TEMP TABLE _tip_accounts AS
  SELECT DISTINCT "recipientAccountId" AS id FROM "ObservedTip"
  WHERE "txHash" LIKE 'rdtip%' OR "txHash" LIKE 'dist-test-tip-%'
    OR "txHash" LIKE 'cs%' OR "txHash" LIKE 'cf%'
  UNION
  SELECT DISTINCT t."recipientAccountId" FROM "ObservedTip" t
  JOIN "MoneroAccount" a ON a.id = t."recipientAccountId"
  WHERE a."ownerUserId" IN (SELECT id FROM _tu);

-- Test distributions: prior shape + any distribution touched by fake-sent
-- payouts or test-user Earn/payouts.
CREATE TEMP TABLE _test_dists AS
  SELECT id FROM "RewardDistribution"
  WHERE "poolPiconeros" = 1000000000000 AND "distributedPiconeros" = 0
    AND "payoutCount" = 0 AND status = 'COMPLETE'
  UNION
  SELECT "distributionId" FROM "RewardPayout"
  WHERE "txHash" = repeat('ab', 32)
  UNION
  SELECT "distributionId" FROM "Earn" WHERE "userId" IN (SELECT id FROM _tu)
  UNION
  SELECT "distributionId" FROM "RewardPayout" WHERE "curatorId" IN (SELECT id FROM _tu);

\echo '--- residue counts being removed ---'
SELECT 'test users' AS t, count(*) FROM _tu;
SELECT 'test distributions' AS t, count(*) FROM _test_dists;

-- Earn: orphans + linked to test dists + test users'.
DELETE FROM "Earn"
WHERE "distributionId" IS NULL
   OR "distributionId" IN (SELECT id FROM _test_dists)
   OR "userId" IN (SELECT id FROM _tu);

-- Payouts of test dists / to test users.
DELETE FROM "RewardPayout"
WHERE "distributionId" IN (SELECT id FROM _test_dists)
   OR "curatorId" IN (SELECT id FROM _tu);

-- Test distributions.
DELETE FROM "RewardDistribution" WHERE id IN (SELECT id FROM _test_dists);

-- Observation fixtures by txHash prefix, plus any tip whose recipient account
-- is a test account (delete before those accounts go, or the FK aborts). The
-- cs/cf tips must go BEFORE the users delete too — their Items cascade on the
-- user delete and ObservedTip_postId_fkey (RESTRICT) blocks it otherwise.
DELETE FROM "FeeObservation" WHERE "txHash" LIKE 'rdfee%';
DELETE FROM "ObservedTip"
WHERE "txHash" LIKE 'rdtip%' OR "txHash" LIKE 'dist-test-tip-%'
   OR "txHash" LIKE 'cs%' OR "txHash" LIKE 'cf%'
   OR "recipientAccountId" IN (SELECT id FROM _tip_accounts);
DELETE FROM "ObservedDownvote" WHERE "txHash" LIKE 'rddv%' OR "txHash" LIKE 'dist-test-downvote-%';

-- Test PayIns (rdfee-linked or test-user-owned).
DELETE FROM "PayIn"
WHERE id IN (SELECT id FROM _fee_payins) OR "userId" IN (SELECT id FROM _tu);

-- Test bounty rows. A test (empty-name) user's payouts block the users delete
-- on BountyPayment_winnerUserId_fkey, ObservedBounty rows pointing at the
-- cascading Items block it on ObservedBounty_postId_fkey, and ObservedBounty
-- also RESTRICTs the test MoneroAccount delete via recipientAccountId — so
-- this cleanup runs BEFORE both. Test signals: winner/item owned by an
-- empty-name user, or fixture hashes ('btest*' payouts, 'uf-*' txHashes /
-- 'obtest*' paymentIds — impossible in real 64-char hex). Escrow journal rows
-- (and their proofs) RESTRICT the payout delete, so they go first. Real
-- payouts are won by named users and are never matched here.
CREATE TEMP TABLE _test_bounties AS
  SELECT id FROM "BountyPayment"
  WHERE "winnerUserId" IN (SELECT id FROM _tu)
     OR "itemId" IN (SELECT i.id FROM "Item" i
                     JOIN users u ON u.id = i."userId" WHERE u.name IS NULL)
     OR "txHash" LIKE 'btest%';

SELECT 'test bounty payouts' AS t, count(*) FROM _test_bounties;

DELETE FROM "PaymentTransactionProof"
WHERE "escrowJournalId" IN (
  SELECT id FROM "EscrowWalletTransaction"
  WHERE "bountyPaymentId" IN (SELECT id FROM _test_bounties));

DELETE FROM "EscrowWalletTransaction"
WHERE "bountyPaymentId" IN (SELECT id FROM _test_bounties);

DELETE FROM "BountyPayment" WHERE id IN (SELECT id FROM _test_bounties);

DELETE FROM "ObservedBounty"
WHERE "postId" IN (SELECT i.id FROM "Item" i
                   JOIN users u ON u.id = i."userId" WHERE u.name IS NULL)
   OR "recipientAccountId" IN (SELECT id FROM _tip_accounts)
   OR "txHash" LIKE 'uf-%'
   OR "paymentId" LIKE 'obtest%';

-- View keys before the accounts they lock.
DELETE FROM "MoneroViewKey"
WHERE "accountId" IN (
  SELECT id FROM "MoneroAccount"
  WHERE address ~ 'A{90}$'
     OR id IN (SELECT id FROM _tip_accounts)
     OR "ownerUserId" IN (SELECT id FROM _tu));

-- Fee subaddresses before the accounts they lock (same three scopes as the
-- account delete below).
DELETE FROM "SubaddressIndex"
WHERE "accountId" IN (
  SELECT id FROM "MoneroAccount"
  WHERE address ~ 'A{90}$'
     OR id IN (SELECT id FROM _tip_accounts)
     OR "ownerUserId" IN (SELECT id FROM _tu));

-- Fee intents frozen to a test account (recipient FK is ON DELETE RESTRICT)
-- before the accounts they lock (same three scopes as the account delete).
DELETE FROM "SubFeePidMap"
WHERE "recipient_account_id" IN (
  SELECT id FROM "MoneroAccount"
  WHERE address ~ 'A{90}$'
     OR id IN (SELECT id FROM _tip_accounts)
     OR "ownerUserId" IN (SELECT id FROM _tu));

-- Test MoneroAccounts.
DELETE FROM "MoneroAccount"
WHERE address ~ 'A{90}$'
   OR id IN (SELECT id FROM _tip_accounts)
   OR "ownerUserId" IN (SELECT id FROM _tu);

-- Test users (their Items cascade; PayIns/Earn/payouts/bounty rows already
-- removed).
-- Reply rows authored by / notifying test users (left behind by payIn-engine
-- comment fixtures) block the user delete below on the Reply_userId_fkey /
-- Reply_ancestorUserId_fkey constraints, so clear them first. Real Reply rows
-- always reference named users and are never matched here.
DELETE FROM "Reply"
WHERE "userId" IN (SELECT id FROM _tu)
   OR "ancestorUserId" IN (SELECT id FROM _tu);

DELETE FROM users WHERE id IN (SELECT id FROM _tu);

DROP TABLE _tu;
DROP TABLE _fee_payins;
DROP TABLE _tip_accounts;
DROP TABLE _test_dists;
DROP TABLE _test_bounties;

COMMIT;
\echo '=== rewards-test residue cleanup complete ==='
SQL
