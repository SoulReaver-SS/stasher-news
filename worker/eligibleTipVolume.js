// Eligible tip volume T for the dynamic curator budget (spec
// 2026-10-19-dynamic-curator-budget-design.md §4).
//
// T sizes the weekly curator budget to ALL eligible curation spending in the
// period, unlike computeCuratorShares which only pays tips on items created in
// the period and inside the top vote percentiles (D5). The turf/trust/founder
// SQL is shared with computeCuratorShares — never copied — so both paths agree
// on what a tipper's turf and trust are.
//
// The single SQL statement returns every stage total, the raw volume, the
// pre-cap per-tipper sums and the tipper count. Per-tipper sums are floored
// after the SUM (the handicap and trust factors may be fractional), then
// capTipperContributions finds the largest level L <= capShare x sum(min(x_i, L)).

import { Prisma } from '@prisma/client'
import { capTipperContributions } from '@/lib/curatorBudget'
import {
  HANDICAP_ZAP_MULT,
  itemTurfSql,
  resolveHandicapIds,
  trustMultiplierSql,
  zapTrustSql
} from '@/worker/curatorShares'

/**
 * Compute the eligible tip volume for a period.
 *
 * @param {object} tx - Prisma client or transaction.
 * @param {object} params
 * @param {Date} params.periodStart - inclusive window start.
 * @param {Date} params.periodEnd - exclusive window end.
 * @param {number} params.trustWeightFloor - effective floor (1.0 when off/stale).
 * @param {number[]} params.excludedCuratorIds - already-resolved exclusion set
 *   (the founder is always included by resolveExcludedCuratorIds).
 * @param {number} params.capShareBps - per-tipper cap share in basis points.
 * @returns {Promise<{
 *   rawPiconeros: bigint,
 *   stages: Record<'raw'|'eligible'|'afterExclusions'|'ranked'|'handicapped'|'trusted'|'capped', string>,
 *   tipperCount: number,
 *   perTipper: bigint[],
 *   cappedPiconeros: bigint,
 *   levelPiconeros: bigint
 * }>}
 */
export async function computeEligibleTipVolume (tx, {
  periodStart,
  periodEnd,
  trustWeightFloor,
  excludedCuratorIds,
  capShareBps
}) {
  const handicapIds = await resolveHandicapIds(tx)

  // Prisma.raw identifiers below are module-owned SQL aliases, never user input.
  const itemRef = Prisma.raw('i')
  const rootRef = Prisma.raw('root')
  const ustRef = Prisma.raw('ust')
  const zapTrustRef = Prisma.raw('zap_trust')

  const [row] = await tx.$queryRaw`
    WITH tips AS (
      SELECT t."tipperId", t.piconeros,
             COALESCE(t."rankPiconeros", t.piconeros) AS rank_piconeros,
             i."userId" AS author_id,
             ${zapTrustSql(itemRef, ustRef)} AS zap_trust
      FROM "ObservedTip" t
      JOIN "Item" i ON i.id = t."postId"
      LEFT JOIN "Item" root ON root.id = i."rootId"
      LEFT JOIN "UserSubTrust" ust
        ON ust."subName" = ${itemTurfSql(itemRef, rootRef)}
       AND ust."userId" = t."tipperId"
      WHERE t.state = 'CONFIRMED'
        AND t."confirmedAt" >= ${periodStart}
        AND t."confirmedAt" < ${periodEnd}
    ),
    eligible AS (
      SELECT * FROM tips
      WHERE "tipperId" IS NOT NULL AND "tipperId" <> author_id
    ),
    included AS (
      SELECT * FROM eligible
      WHERE NOT ("tipperId" = ANY(${excludedCuratorIds}::int[]))
    ),
    weighted AS (
      SELECT "tipperId",
        rank_piconeros::numeric
          * CASE WHEN "tipperId" = ANY(${handicapIds}::int[]) THEN ${HANDICAP_ZAP_MULT}::numeric ELSE 1 END
          AS handicapped_rank,
        ${trustMultiplierSql(trustWeightFloor, zapTrustRef)} AS trust_mult
      FROM included
    ),
    per_tipper AS (
      SELECT "tipperId",
        FLOOR(SUM(handicapped_rank))::bigint AS handicapped,
        FLOOR(SUM(handicapped_rank * trust_mult::numeric))::bigint AS trusted
      FROM weighted
      GROUP BY "tipperId"
    )
    SELECT
      (SELECT COALESCE(SUM(piconeros), 0) FROM tips)::bigint AS raw,
      (SELECT COALESCE(SUM(piconeros), 0) FROM eligible)::bigint AS eligible,
      (SELECT COALESCE(SUM(piconeros), 0) FROM included)::bigint AS after_exclusions,
      (SELECT COALESCE(SUM(rank_piconeros), 0) FROM included)::bigint AS ranked,
      COALESCE((SELECT SUM(handicapped) FROM per_tipper), 0)::bigint AS handicapped,
      COALESCE((SELECT SUM(trusted) FROM per_tipper), 0)::bigint AS trusted,
      COALESCE(
        (SELECT json_agg(trusted::text ORDER BY "tipperId") FROM per_tipper),
        '[]'::json
      ) AS tippers`

  const perTipper = (row.tippers ?? []).map(value => BigInt(value))
  const rawPiconeros = BigInt(row.raw)
  const cap = capTipperContributions(perTipper, capShareBps)

  return {
    rawPiconeros,
    stages: {
      raw: rawPiconeros.toString(),
      eligible: BigInt(row.eligible).toString(),
      afterExclusions: BigInt(row.after_exclusions).toString(),
      ranked: BigInt(row.ranked).toString(),
      handicapped: BigInt(row.handicapped).toString(),
      trusted: BigInt(row.trusted).toString(),
      capped: cap.tPiconeros.toString()
    },
    tipperCount: perTipper.filter(value => value > 0n).length,
    perTipper,
    cappedPiconeros: cap.tPiconeros,
    levelPiconeros: cap.levelPiconeros
  }
}
