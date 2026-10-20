import createPrisma from '@/lib/create-prisma'
import { nymsToIds, HANDICAP_NYMS } from '@/lib/founderNyms'
import { logError } from '@/lib/logger'
import { META_SUB, USER_ID } from '@/lib/constants'

// computeCuratorShares — the share-computation core of StasherNews' weekly
// rewardsDistributor (Phase 4 Task 7 / design spec §5). It ports Stacker.news'
// worker/earn.js reward CTE verbatim, changing ONLY the input source: confirmed
// ObservedTip rows (P2P Monero tips) replace the legacy PayIn ZAP records, and
// the pool unit is piconeros (1e-12 XMR).
//
// What was dropped vs earn.js (per the design spec):
//   - the ITEM_CREATE PayIn LATERAL join + America/Chicago day filter -> a direct
//     Item.createdAt range filter [periodStart, periodEnd);
//   - the EACH_ITEM_PORTION (item-author) UNION branch (SN sets it to 0 — dead
//     code; StasherNews rewards curators only);
//   - the entire referral machinery (OneDayReferral / foreverReferrerId).
//
// What was kept: NTILE(100) percentile cutoff, the "islands" contiguous-zap
// dedupe, the power(sum, 0.25) quad-root diminishing returns, the
// 1/LN(rank + e - 1) early-tipper boost, the HANDICAP_NYMS / HANDICAP_ZAP_MULT
// 0.5x curator multiplier (staff/founder users weigh half; restored per A-09),
// the per-partition (post vs comment) normalization split by EACH_ZAP_PORTION,
// and the per-user total_proportion roll-up.
//
// One StasherNews-specific exception: the founder account `stasher` is not a
// curator-reward recipient at all, and operators may exclude additional accounts
// through PlatformFeeConfig.distributionExcludedCuratorIds. Their tips still
// participate in the earlier tip-ordering and trust stages, but they are removed
// from the final post/comment attribution before normalization and ranking, so
// they never earn a share or consume a topN slot.
//
// This module is PURE: it computes shares and returns them. It touches no wallet,
// creates no rows, and wires no job (Task 8's rewardsDistributor calls this and
// performs the on-chain payouts).

// --- Constants (mirror earn.js, adapted to piconeros) ---

// Only items in the top PERCENTILE_CUTOFF percentiles (by weightedVotes -
// weightedDownVotes) earn rewards for their curators. Same value as earn.js.
const PERCENTILE_CUTOFF = 50

// Each recipient class (post-curator vs comment-curator) is allocated
// 1/EACH_ZAP_PORTION of its partition's proportion. 2.0 => posts and comments
// each carry half the total curator weight (an even split). Same value as earn.js.
const EACH_ZAP_PORTION = 2.0

// Dust floor: an island of tips must total more than this many piconeros to count
// toward curator rewards. Set to the protocol minimum tip (1e8 piconeros =
// 0.0001 XMR) — tips at or below this don't exist on the wire anyway, so this is
// belt-and-braces against rounding/indexer artefacts. This is the ONE place the
// piconeros unit is load-bearing: the power(sum, 0.25) quad-root uses the raw
// piconeros magnitude, but since the final share is normalized
// (proportion / sum(proportion)), any constant divisor on the amount would
// cancel — so only this HAVING dust filter is unit-sensitive.
const ZAP_THRESHOLD_PICONEROS = 100_000_000n

// SN-parity handicap (restored per A-09): staff/founder accounts get a 0.5x
// curator multiplier (their curation still counts, but at half weight). Ids
// are resolved at compute time from HANDICAP_NYMS (lib/founderNyms.js):
// 'stasher' (616) and 'sn' (4502) are migration-guaranteed; 'untraceable'
// (the founder's personal account) resolves once it exists. Anon is
// deliberately NOT handicapped (never reaches curator attribution anyway).
// The founder account `stasher` is excluded outright below, so its handicap
// entry is inert; the multiplier still applies to the remaining accounts.
const HANDICAP_ZAP_MULT = 0.5

// The founder account is not eligible for weekly curator rewards. Use the
// migration-guaranteed id (not the mutable display name). This filter runs in
// the final attribution query, after tip islands/trust and before the rank and
// normalization windows, so stasher's tips can still affect early-tipper
// ordering and item-level proportions but stasher itself never earns.
const CURATOR_EXCLUDED_ID = USER_ID.stasher

// Operator-managed exclusions (PlatformFeeConfig.distributionExcludedCuratorIds)
// are merged with the permanent founder exclusion. Only genuine positive
// PostgreSQL int4 ids are accepted; anything else is ignored so malformed config
// can never unexpectedly change payouts. A non-array value is ignored as a
// whole, while invalid entries inside an array are skipped (valid entries still
// apply).
const MAX_POSTGRES_INT = 2_147_483_647

export function sanitizeExcludedCuratorIds (configured) {
  if (configured == null) return []
  if (!Array.isArray(configured)) {
    logError({ valueType: typeof configured }, 'curatorShares: ignoring malformed distributionExcludedCuratorIds (expected an array of integer user ids)')
    return []
  }
  const ids = []
  let invalidCount = 0
  for (const id of configured) {
    if (!Number.isInteger(id) || id <= 0 || id > MAX_POSTGRES_INT) {
      invalidCount += 1
      continue
    }
    if (!ids.includes(id)) ids.push(id)
  }
  if (invalidCount > 0) {
    logError({ invalidCount }, 'curatorShares: ignoring invalid distributionExcludedCuratorIds entries')
  }
  return ids
}

// The complete exclusion set for a computation: the founder is ALWAYS present,
// regardless of operator config. Order is deterministic (founder first).
export function resolveExcludedCuratorIds (configured) {
  return [...new Set([CURATOR_EXCLUDED_ID, ...sanitizeExcludedCuratorIds(configured)])]
}

// --- Curator trust weighting (#6) ---

// The nightly trust walk (02:00 UTC) writes a dedicated heartbeat
// (HealthSnapshot.trustCompletedAt) only after a fully-successful run. If
// that heartbeat is missing or older than 26h (one full missed run plus
// slack), the walk is stale: weighting that week's distribution would
// discount EVERY curator to the floor, so the distributor falls back to
// 1.0 (weighting disabled).
export const TRUST_STALENESS_MS = 26 * 60 * 60 * 1000

// Clamp/sanitize a configured floor. Only a genuine finite number in [0, 1]
// is accepted — anything else (null, undefined, '', numeric strings, NaN,
// out-of-range) disables weighting (1.0). Strict typeof check is DELIBERATE:
// Number(null) and Number('') coerce to 0, which would silently apply the
// harshest floor (zero-trust curators excluded) instead of disabling —
// violating the "malformed config must never change payouts" contract.
function sanitizeTrustWeightFloor (floor) {
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    logError(`computeCuratorShares: invalid trustWeightFloor ${floor}; falling back to 1.0 (weighting disabled)`)
    return 1.0
  }
  return floor
}

// Effective floor for a distribution run: the configured value, unless the
// trust walk is stale — then 1.0 so an outage can never slash everyone's
// rewards to the floor. Pure; `newestTrustUpdatedAt` is the walk's dedicated
// heartbeat (HealthSnapshot.trustCompletedAt, written only after a
// fully-successful run; null when never written).
export function effectiveTrustWeightFloor (configFloor, newestTrustUpdatedAt, now = Date.now()) {
  const configured = sanitizeTrustWeightFloor(configFloor)
  if (configured === 1.0) return 1.0
  if (!(newestTrustUpdatedAt instanceof Date) || Number.isNaN(newestTrustUpdatedAt.getTime())) return 1.0
  if (now - newestTrustUpdatedAt.getTime() > TRUST_STALENESS_MS) return 1.0
  return configured
}

// Apportion a curator's share across their earn types by typeProportion
// (mirrors the upstream SN per-type apportionment: normalize per curator, floor
// each, give the rounding remainder to the highest-proportion type). Per-type
// amounts sum exactly to sharePiconeros.
function apportionEarns (earns, sharePiconeros) {
  if (earns.length === 0) return []
  const total = earns.reduce((acc, e) => acc + e.typeProportion, 0)
  const shareNum = Number(sharePiconeros)
  const apportioned = earns.map(e => ({
    type: e.type,
    rank: e.rank,
    piconeros: total > 0 ? BigInt(Math.floor((e.typeProportion / total) * shareNum)) : 0n
  }))
  const distributed = apportioned.reduce((acc, e) => acc + e.piconeros, 0n)
  const remainder = sharePiconeros - distributed
  if (remainder > 0n) {
    let maxIdx = 0
    for (let i = 1; i < earns.length; i++) {
      if (earns[i].typeProportion > earns[maxIdx].typeProportion) maxIdx = i
    }
    apportioned[maxIdx].piconeros += remainder
  }
  return apportioned
}

/**
 * Compute curator reward shares for a period.
 *
 * @param {Date} periodStart - inclusive start of the reward window.
 * @param {Date} periodEnd   - exclusive end of the reward window.
 * @param {bigint} poolPiconeros - total piconeros to distribute this period.
 * @param {{ minPayout?: bigint, topN?: number, trustWeightFloor?: number, excludedCuratorIds?: number[] }} [opts]
 *   - minPayout: shares below this are excluded and roll over (NOT redistributed).
 *   - topN: cap on the number of recipients (highest proportion first).
 *   - excludedCuratorIds: operator-configured accounts that never earn a share.
 *     The founder is always excluded in addition to this list.
 * @param {object} [models] - Prisma client. A throwaway client is created if
 *   omitted (and disconnected after the query).
 * @returns {Promise<{ shares: Array<{ curatorId: number, sharePiconeros: bigint, earns: Array<{ type: 'TIP_POST'|'TIP_COMMENT', rank: number, piconeros: bigint }> }>, distributedPiconeros: bigint, rolledOverPiconeros: bigint }>}
 *   `share.earns` partitions `sharePiconeros` by content type; its piconeros sum
 *   exactly to `sharePiconeros`. Consumed when writing per-(curator,type) Earn rows.
 */
export async function computeCuratorShares (periodStart, periodEnd, poolPiconeros, { minPayout = 0n, topN = 100, trustWeightFloor = 1.0, excludedCuratorIds = [] } = {}, models) {
  const ownsClient = !models
  const db = ownsClient ? createPrisma() : models
  const floor = sanitizeTrustWeightFloor(trustWeightFloor)
  const excludedIds = resolveExcludedCuratorIds(excludedCuratorIds)
  try {
    return await compute(db, periodStart, periodEnd, poolPiconeros, minPayout, topN, floor, excludedIds)
  } finally {
    if (ownsClient) db.$disconnect().catch(console.error)
  }
}

async function compute (models, periodStart, periodEnd, poolPiconeros, minPayout, topN, trustWeightFloor, excludedIds) {
  const handicapIds = await nymsToIds(models, HANDICAP_NYMS)
  // Per-curator raw proportions from the ported CTE. Each row is
  // { curatorId: number, total_proportion: number, earns: string (json_agg text) }.
  const prospects = await models.$queryRaw`
    WITH reward_proportions AS (
      WITH item_proportions AS (
        SELECT *,
          CASE WHEN "parentId" IS NULL THEN 'POST' ELSE 'COMMENT' END AS type,
          CASE WHEN "weightedVotes" > 0
            THEN "weightedVotes" / (sum("weightedVotes") OVER (PARTITION BY "parentId" IS NULL))
            ELSE 0 END AS proportion
        FROM (
          -- #6: the root join puts every Item column name into the range table
          -- TWICE, so ALL Item references below MUST stay "Item".-qualified —
          -- unqualified "weightedVotes"/"parentId"/"deletedAt"/bio raise
          -- Postgres 42702 ambiguous-column (verified on the dev DB
          -- 2026-09-14). Turf resolution mirrors api/monero/ranking.js:92
          -- (root subNames win for comments; turf-less items are META_SUB).
          SELECT "Item".*,
            COALESCE(root."subNames"[1], "Item"."subNames"[1], ${META_SUB}::CITEXT) AS turf,
            NTILE(100) OVER (PARTITION BY "Item"."parentId" IS NULL ORDER BY ("Item"."weightedVotes" - "Item"."weightedDownVotes") DESC) AS percentile,
            ROW_NUMBER() OVER (PARTITION BY "Item"."parentId" IS NULL ORDER BY ("Item"."weightedVotes" - "Item"."weightedDownVotes") DESC) AS rank
          FROM "Item"
          LEFT JOIN "Item" root ON root.id = "Item"."rootId"
          WHERE "Item"."created_at" >= ${periodStart}
            AND "Item"."created_at" < ${periodEnd}
            AND "Item"."weightedVotes" > 0
            AND "Item"."deletedAt" IS NULL
            AND NOT "Item".bio
        ) x
        WHERE x.percentile <= ${PERCENTILE_CUTOFF}
      ),
      -- gather the confirmed Monero tips on those top items, with the "islands"
      -- trick: the difference of two ROW_NUMBER()s gives a stable group id for
      -- each contiguous run of tips from the same user on the same item, so a
      -- burst of successive tips is collapsed before the quad-root (preventing
      -- disproportionate reward for splitting a tip into many pieces).
      -- #6: also carry the tipper's trust in the item's turf (zapPostTrust for
      -- posts, zapCommentTrust for comments; no row => 0). The LEFT JOIN is
      -- 1:1 at most (PK userId+subName), so no row fanout.
      item_zapper_islands AS (
        SELECT "ObservedTip"."tipperId" AS "userId",
          item_proportions.id,
          item_proportions.proportion,
          item_proportions."parentId",
          item_proportions.turf,
          "ObservedTip"."piconeros" AS zapped_piconeros,
          "ObservedTip"."confirmedAt" AS acted_at,
          COALESCE(CASE WHEN item_proportions."parentId" IS NULL
            THEN ust."zapPostTrust" ELSE ust."zapCommentTrust" END, 0) AS zap_trust,
          ROW_NUMBER() OVER (PARTITION BY item_proportions.id ORDER BY "ObservedTip"."confirmedAt" ASC)
            - ROW_NUMBER() OVER (PARTITION BY item_proportions.id, "ObservedTip"."tipperId" ORDER BY "ObservedTip"."confirmedAt" ASC) AS island
        FROM item_proportions
        JOIN "ObservedTip" ON "ObservedTip"."postId" = item_proportions.id
          AND "ObservedTip"."state" = 'CONFIRMED'
          AND "ObservedTip"."confirmedAt" >= ${periodStart}
          AND "ObservedTip"."confirmedAt" < ${periodEnd}
          AND "ObservedTip"."tipperId" IS NOT NULL
        LEFT JOIN "UserSubTrust" ust
          ON ust."subName" = item_proportions.turf
         AND ust."userId" = "ObservedTip"."tipperId"
      ),
      -- one row per (user, item, island): quad-root of the tipped piconeros.
      -- power(sum, 0.25) gives diminishing returns (each additional piconero
      -- rewards less than the last). The legacy /1000 divisor is dropped: it
      -- was a constant divisor that cancels under the final normalization.
      -- #6: min(zap_trust) — constant within the island (same tipper+turf),
      -- aggregated to satisfy GROUP BY.
      item_zappers AS (
        SELECT "userId",
          item_zapper_islands.id,
          item_zapper_islands.proportion,
          item_zapper_islands."parentId",
          GREATEST(power(sum(zapped_piconeros)::float, 0.25), 0) AS zapped,
          min(acted_at) AS acted_at,
          min(zap_trust) AS zap_trust
        FROM item_zapper_islands
        GROUP BY "userId", item_zapper_islands.id, item_zapper_islands.proportion, item_zapper_islands."parentId", island
        HAVING sum(zapped_piconeros) > ${ZAP_THRESHOLD_PICONEROS}
      ),
      -- the relative contribution of each curator to the post/comment:
      --   early component  = 1/LN(rank + e - 1)   (earlier tippers win)
      --   tipped component = their share of the item's total tipped weight
      --   item component   = the item's share of the period's vote weight
      --   trust component  (#6) = floor + (1 - floor) * zap_trust, applied
      --   per (curator, item) INSIDE the sum (trust varies by item turf).
      --   floor = 1.0 (default) multiplies by exactly 1.0: bit-for-bit legacy.
      item_zapper_ratios AS (
        SELECT "userId",
          sum((2 * early_multiplier + 1) * zapped_proportion * proportion
              * (${trustWeightFloor}::DOUBLE PRECISION + (1.0 - ${trustWeightFloor}::DOUBLE PRECISION) * zap_trust))
            * CASE WHEN "userId" = ANY(${handicapIds}::int[]) THEN ${HANDICAP_ZAP_MULT} ELSE 1 END AS item_zapper_proportion,
          "parentId" IS NULL AS "isPost"
        FROM (
          SELECT *,
            1.0 / LN(ROW_NUMBER() OVER (PARTITION BY item_zappers.id ORDER BY acted_at ASC) + EXP(1.0) - 1) AS early_multiplier,
            zapped::float / (sum(zapped) OVER (PARTITION BY item_zappers.id)) AS zapped_proportion
          FROM item_zappers
          WHERE zapped > 0
        ) u
        JOIN users ON "userId" = users.id
        GROUP BY "userId", "parentId" IS NULL
      )
      -- normalize within the post/comment partition, then split each partition's
      -- weight by EACH_ZAP_PORTION (2.0 => posts and comments each get half).
      -- Carry type + rank (over all qualifying curators in the partition) so the
      -- distributor can write SN-parity per-(curator, type) Earn rows.
      SELECT "userId",
        CASE WHEN "isPost" THEN 'TIP_POST' ELSE 'TIP_COMMENT' END AS type,
        ROW_NUMBER() OVER (PARTITION BY "isPost" ORDER BY item_zapper_proportion DESC) AS rank,
        item_zapper_proportion / (sum(item_zapper_proportion) OVER (PARTITION BY "isPost")) / ${EACH_ZAP_PORTION} AS "typeProportion"
      FROM item_zapper_ratios
      WHERE item_zapper_proportion > 0
        AND ${EACH_ZAP_PORTION} > 0
        AND NOT ("userId" = ANY(${excludedIds}::int[]))
    )
    -- roll every curator's per-type proportions up into one total, keeping the
    -- per-type breakdown (type/rank/typeProportion) for Earn row writing.
    SELECT "userId" AS "curatorId",
      sum("typeProportion") AS "total_proportion",
      json_agg(json_build_object('type', "type", 'rank', "rank", 'typeProportion', "typeProportion"))::text AS "earns"
    FROM reward_proportions
    GROUP BY "userId"`

  // --- JS post-processing: normalize to piconeros, cap, and floor the dust. ---

  const rows = prospects.map(r => ({
    curatorId: Number(r.curatorId),
    totalProportion: Number(r.total_proportion),
    earns: JSON.parse(r.earns).map(e => ({
      type: e.type,
      rank: Number(e.rank),
      typeProportion: Number(e.typeProportion)
    }))
  }))

  const sumProportion = rows.reduce((acc, r) => acc + r.totalProportion, 0)
  if (!rows.length || sumProportion <= 0 || poolPiconeros <= 0n) {
    return { shares: [], distributedPiconeros: 0n, rolledOverPiconeros: poolPiconeros }
  }

  // floor(prop_i / sum(prop) * pool). NOTE: Number(pool) is exact for pools up to
  // ~9e15 piconeros (2^53), which is ~9000 XMR/week — far beyond any realistic v1
  // pool. The brief mandates this floor-and-normalize in JS.
  const poolNum = Number(poolPiconeros)
  let ranked = rows
    .map(r => ({
      curatorId: r.curatorId,
      totalProportion: r.totalProportion,
      sharePiconeros: BigInt(Math.floor(r.totalProportion / sumProportion * poolNum)),
      earns: r.earns
    }))
    // topN: keep only the highest-proportion curators.
    .sort((a, b) => b.totalProportion - a.totalProportion)
  if (ranked.length > topN) ranked = ranked.slice(0, topN)

  // minPayout: exclude sub-min shares. Their piconeros are NOT redistributed —
  // they roll over to next period's pool (handled by the caller).
  const minBig = BigInt(minPayout)
  const shares = ranked
    .filter(s => s.sharePiconeros >= minBig)
    .map(s => ({
      curatorId: s.curatorId,
      sharePiconeros: s.sharePiconeros,
      earns: apportionEarns(s.earns, s.sharePiconeros)
    }))

  const distributedPiconeros = shares.reduce((acc, s) => acc + s.sharePiconeros, 0n)
  const rolledOverPiconeros = poolPiconeros - distributedPiconeros

  return { shares, distributedPiconeros, rolledOverPiconeros }
}
