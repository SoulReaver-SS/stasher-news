-- Dev-only cleanup: remove automated-test artifacts (load tests + rewards
-- distribution fixture runs) from the observation tables and their users.
-- Real platform activity (real 64-hex tx hashes) is untouched.
--
-- Run with:
--   docker compose exec -T db psql -U sn -d stackernews -f - < scripts/cleanup-dev-test-data.sql

BEGIN;

-- 1. observation rows with fake tx hashes (load test: 0x0000.../pending-0000...;
--    distribution tests: dist-test-...; debug-turf fixtures: dbgtip...)
DELETE FROM "ObservedTip"
WHERE "txHash" LIKE '0x%' OR "txHash" LIKE 'pending-%' OR "txHash" LIKE 'dist-test-%' OR "txHash" LIKE 'dbgtip%';

DELETE FROM "ObservedDownvote"
WHERE "txHash" LIKE '0x%' OR "txHash" LIKE 'pending-%' OR "txHash" LIKE 'dist-test-%' OR "txHash" LIKE 'dbgtip%';

DELETE FROM "FeeObservation"
WHERE "txHash" LIKE '0x%' OR "txHash" LIKE 'pending-%' OR "txHash" LIKE 'dist-test-%' OR "txHash" LIKE 'dbgtip%';

-- 1b. debug-turf fixture subs: capture their fixture users (sub owners + post
--     authors; nameless) before the items/subs they own are deleted
CREATE TEMP TABLE dbg_turf_users ON COMMIT DROP AS
SELECT id FROM users
WHERE id IN (SELECT "userId" FROM "Sub" WHERE name LIKE 'dbg-turf%')
   OR id IN (SELECT "userId" FROM "Item" WHERE "subName" LIKE 'dbg-turf%');

DELETE FROM "SubaddressIndex"
WHERE "accountId" IN (SELECT id FROM "MoneroAccount" WHERE "ownerUserId" IN (SELECT id FROM dbg_turf_users));

DELETE FROM "MoneroViewKey"
WHERE "accountId" IN (SELECT id FROM "MoneroAccount" WHERE "ownerUserId" IN (SELECT id FROM dbg_turf_users));

-- fee intents frozen to these accounts (recipient FK is ON DELETE RESTRICT)
DELETE FROM "SubFeePidMap"
WHERE "recipient_account_id" IN (SELECT id FROM "MoneroAccount" WHERE "ownerUserId" IN (SELECT id FROM dbg_turf_users));

DELETE FROM "MoneroAccount"
WHERE "ownerUserId" IN (SELECT id FROM dbg_turf_users);

DELETE FROM "PayIn"
WHERE "userId" IN (SELECT id FROM dbg_turf_users);

DELETE FROM "UserSubTrust" WHERE "subName" LIKE 'dbg-turf%';
DELETE FROM "SubSubscription" WHERE "subName" LIKE 'dbg-turf%';
DELETE FROM "MuteSub" WHERE "subName" LIKE 'dbg-turf%';
DELETE FROM "ItemSub" WHERE "subName" LIKE 'dbg-turf%';

DELETE FROM "Item"
WHERE "userId" IN (SELECT id FROM dbg_turf_users) OR "subName" LIKE 'dbg-turf%';

DELETE FROM "Sub" WHERE name LIKE 'dbg-turf%';

DELETE FROM users WHERE id IN (SELECT id FROM dbg_turf_users);

-- 2. monero account fixtures of the test users (subaddresses + view keys first,
--    since they reference the account)
DELETE FROM "SubaddressIndex"
WHERE "accountId" IN (
  SELECT id FROM "MoneroAccount"
  WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%')
);

DELETE FROM "MoneroViewKey"
WHERE "accountId" IN (
  SELECT id FROM "MoneroAccount"
  WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%')
);

DELETE FROM "SubFeePidMap"
WHERE "recipient_account_id" IN (
  SELECT id FROM "MoneroAccount"
  WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%')
);

DELETE FROM "MoneroAccount"
WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%');

-- 3. any payIns / items of the test users (items after observations are gone;
--    user deletion cascades the rest)
DELETE FROM "PayIn"
WHERE "userId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%');

DELETE FROM "Item"
WHERE "userId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%');

DELETE FROM users
WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%';

COMMIT;
