-- Seed the 'worldnews' default platform territory (world news / geopolitics)
-- so fresh deployments and the live DB have a general-news turf. Complements
-- 20260802120000_seed_default_territories (bitcoin, tech, stasher, jobs,
-- monero) and 20260818000000_seed_crypto_bounties_memes_territories (crypto,
-- bounties, memes). lib/constants.js DEFAULT_SUBS is updated to mirror this.
--
-- A free ONCE territory (never billed — territoryBilling refuses ONCE
-- subs), billingStatus PAID, status ACTIVE, supporting every fork PostType
-- (LINK, DISCUSSION, JOB, POLL, BOUNTY — matching the postTypes the live
-- default turfs carry). Idempotent: safe to re-run.
--
-- Owner: the founder/platform account 'stasher' at reserved id 616
-- (USER_ID.stasher is the migration-guaranteed platform account).

-- Fresh-install fallback: ensure stasher exists at id 616 even if an earlier
-- migration was skipped (e.g. a clone that never ran it).
INSERT INTO "users" ("id", "name")
VALUES (616, 'stasher')
ON CONFLICT DO NOTHING;

-- Reference the owner by name so the sub insert works whether stasher landed at
-- id 616 or was skipped because a 'stasher' by name already existed elsewhere.
INSERT INTO "Sub" (
  "name", "userId", "postTypes", "rankingType",
  "billingType", "billingCost", "status", "billingStatus"
)
SELECT
  v.name,
  u.id,
  ARRAY['LINK', 'DISCUSSION', 'JOB', 'POLL', 'BOUNTY']::"PostType"[],
  'WOT',
  'ONCE',
  0,
  'ACTIVE',
  'PAID'
FROM (VALUES
  ('worldnews')
) AS v(name)
CROSS JOIN "users" u
WHERE u.name = 'stasher'
ON CONFLICT (name) DO NOTHING;

-- Fixed-id inserts (users 616 above, fallback only) do not advance the serial
-- sequence: repeat the resync DO block per 20260903000000_resync_id_sequences.
DO $$
DECLARE
  t RECORD;
  max_id BIGINT;
  seq TEXT;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'id')
  LOOP
    seq := pg_get_serial_sequence(format('public.%I', t.table_name), 'id');
    CONTINUE WHEN seq IS NULL;
    EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM public.%I', t.table_name) INTO max_id;
    CONTINUE WHEN max_id = 0;
    PERFORM setval(seq::regclass, max_id);
  END LOOP;
END $$;
