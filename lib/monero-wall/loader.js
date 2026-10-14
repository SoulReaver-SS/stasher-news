// lib/monero-wall/loader.js
// Request-scoped DataLoader for Monerowall entitlement state. One grouped
// query per concern per request — never N+1 in list paths.
import DataLoader from 'dataloader'
import { CHAIN_TIP_MAX_AGE_MS, RATING_CONFIRMATIONS } from '@/lib/constants'

const EMPTY = Object.freeze({ progressPiconeros: 0n, myContributionPiconeros: 0n, myRateablePiconeros: 0n, frozen: false })

function valuesFor (keys, startIndex) {
  const params = []
  const tuples = keys.map((key, i) => {
    params.push(Number(key.id), key.enabledAt)
    return `($${startIndex + i * 2 + 1}::INTEGER, $${startIndex + i * 2 + 2}::TIMESTAMPTZ)`
  })
  return { values: tuples.join(','), params }
}

async function loadProgress (models, keys) {
  const { values, params } = valuesFor(keys, 0)
  const rows = await models.$queryRawUnsafe(
    `SELECT w."postId",
            COALESCE(SUM(CASE WHEN t.state = 'CONFIRMED' AND t."exclusionReason" IS NULL THEN t.piconeros ELSE 0 END), 0)::BIGINT AS "progressPiconeros",
            COUNT(t.id)::INTEGER AS "detectedCount"
     FROM (VALUES ${values}) AS w("postId", "enabledAt")
     LEFT JOIN "ObservedTip" t
       ON t."postId" = w."postId" AND t."detectedAt" >= w."enabledAt" AND t.state <> 'EXPIRED'
     GROUP BY w."postId"`,
    ...params
  )
  return new Map(rows.map(row => [Number(row.postId), row]))
}

async function loadContributions (models, userId, keys) {
  const { values, params } = valuesFor(keys, 0)
  // Zero-conf tiers (2026-09-22 spec): entitlement counts DETECTED+CONFIRMED;
  // the rateable tier (rating eligibility) additionally requires mined depth
  // >= RATING_CONFIRMATIONS, derived from the ChainState tip. A missing or
  // stale tip collapses the rateable branch to CONFIRMED-only — grants late,
  // never early.
  const tip = await models.chainState?.findUnique({ where: { id: 1 } })
  const tipFresh = tip && (Date.now() - new Date(tip.updatedAt).getTime()) < CHAIN_TIP_MAX_AGE_MS
  const rateableCase = tipFresh
    ? `CASE WHEN t.state = 'CONFIRMED'
              OR (t.state = 'DETECTED' AND t.height IS NOT NULL
                  AND ${Number(tip.chainHeight)} - t.height + 1 >= ${RATING_CONFIRMATIONS})
             THEN t.piconeros ELSE 0 END`
    : "CASE WHEN t.state = 'CONFIRMED' THEN t.piconeros ELSE 0 END"
  const rows = await models.$queryRawUnsafe(
    `SELECT w."postId",
            COALESCE(SUM(t.piconeros), 0)::BIGINT AS "contributionPiconeros",
            COALESCE(SUM(${rateableCase}), 0)::BIGINT AS "rateablePiconeros"
     FROM (VALUES ${values}) AS w("postId", "enabledAt")
     JOIN "ObservedTip" t
       ON t."postId" = w."postId" AND t."detectedAt" >= w."enabledAt"
     WHERE t."tipperId" = $${params.length + 1}::INTEGER
       AND t.state IN ('DETECTED', 'CONFIRMED')
       AND t."exclusionReason" IS NULL
     GROUP BY w."postId"`,
    ...params, Number(userId)
  )
  return new Map(rows.map(row => [Number(row.postId), row]))
}

/**
 * Request-scoped DataLoader for thread-root wall config: comment-gating
 * resolvers look up the root's Monerowall columns by rootId. One grouped
 * query per request per root; null for a missing id.
 * @param {{ models: object }} params
 * @returns {DataLoader<number, object|null>}
 */
export function createRootItemLoader ({ models }) {
  return new DataLoader(
    async (ids) => {
      const unique = [...new Set(ids.map(Number))]
      const rows = await models.item.findMany({
        where: { id: { in: unique } },
        select: {
          id: true,
          userId: true,
          parentId: true,
          rootId: true,
          moneroWallPricePiconeros: true,
          moneroWallThresholdPiconeros: true,
          moneroWallEnabledAt: true,
          moneroWallRemovedAt: true,
          moneroWallCoversComments: true,
          moneroWallCommentsRemovedAt: true
        }
      })
      const byId = new Map(rows.map(row => [Number(row.id), row]))
      return ids.map(id => byId.get(Number(id)) ?? null)
    },
    { cacheKeyFn: key => Number(key) }
  )
}

/**
 * @param {{ models: object, me: { id: number|string }|null }} params
 * @returns {DataLoader<{id:number, enabledAt:Date}, {progressPiconeros:bigint, myContributionPiconeros:bigint, myRateablePiconeros:bigint, frozen:boolean}>}
 */
export function createMoneroWallLoader ({ models, me }) {
  return new DataLoader(
    async (keys) => {
      const unique = []
      const seen = new Set()
      for (const key of keys) {
        const id = Number(key.id)
        if (seen.has(id)) continue
        seen.add(id)
        unique.push({ ...key, id })
      }
      const [progressByPost, contributionByPost] = await Promise.all([
        loadProgress(models, unique),
        me?.id != null ? loadContributions(models, me.id, unique) : Promise.resolve(new Map())
      ])
      const byId = new Map()
      for (const key of unique) {
        const progress = progressByPost.get(key.id)
        byId.set(key.id, {
          progressPiconeros: BigInt(progress?.progressPiconeros ?? 0n),
          myContributionPiconeros: BigInt(contributionByPost.get(key.id)?.contributionPiconeros ?? 0n),
          myRateablePiconeros: BigInt(contributionByPost.get(key.id)?.rateablePiconeros ?? 0n),
          frozen: Number(progress?.detectedCount ?? 0) > 0
        })
      }
      return keys.map(key => byId.get(Number(key.id)) ?? EMPTY)
    },
    { cacheKeyFn: key => String(key.id) }
  )
}
