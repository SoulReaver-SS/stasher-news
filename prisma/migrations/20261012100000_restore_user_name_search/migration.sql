-- Restore public.search_users_by_name(text, real, integer) (Finding 4).
-- Both resolver call sites — userSuggestions (api/resolvers/user.js) and
-- searchUsers — call this helper, but the fork's migration history never
-- created it, so every name search failed with SQLSTATE 42883
-- ("function search_users_by_name(text, real, integer) does not exist").
-- The pg_trgm extension and users_name_trgm_idx already exist (created by the
-- 20260727054513 baseline migration); the IF NOT EXISTS restatement is
-- defensive so this helper's migration can never fail for a missing index.
--
-- Differences from the upstream (stacker.news) definition this is restored
-- from:
--   * the caller's pg_trgm.similarity_threshold is clamped to [0, 1] instead
--     of trusting the argument verbatim, so direct callers stay predictable;
--   * the function-scoped SET and the is_local set_config() restore the
--     caller's threshold on exit even when the call happens inside a larger
--     pooled transaction;
--   * result_limit is clamped defensively (NULL -> 5, negative -> 0).
-- No SECURITY DEFINER: the function runs with the caller's privileges.

CREATE INDEX IF NOT EXISTS "users_name_trgm_idx"
ON public.users USING GIN (name gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_users_by_name(
  search_q text, similarity_threshold real, result_limit integer
)
RETURNS SETOF public.users
LANGUAGE plpgsql
SET pg_trgm.similarity_threshold = '0.3'
AS $function$
BEGIN
  PERFORM set_config(
    'pg_trgm.similarity_threshold',
    greatest(0::real, least(coalesce(similarity_threshold, 0.1::real), 1::real))::text,
    true
  );

  RETURN QUERY
    SELECT u.* FROM public.users u
    WHERE (u.id > 615 OR u.id IN (27, 106))
      AND u.name % search_q
    ORDER BY similarity(u.name, search_q) DESC, u.name ASC
    LIMIT greatest(coalesce(result_limit, 5), 0);
END;
$function$;
