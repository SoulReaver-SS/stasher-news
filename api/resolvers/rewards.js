import { amountSchema, validateSchema } from '@/lib/validate'
import { getItem } from './item'
import { GqlInputError } from '@/lib/error'
import pay from '../payIn'
import { getNextRewardsPool, rewardsFromInflow } from '@/lib/rewardsPool'
import { readRewardsInflow } from '../monero/rewardsInflow'

const DAY_MS = 24 * 60 * 60 * 1000

let rewardCache

async function updateCachedRewards (models) {
  const rewards = await getActiveRewards(models)
  rewardCache = { rewards, createdAt: Date.now() }
  return rewards
}

async function getCachedActiveRewards (staleIn, models) {
  if (rewardCache) {
    const { rewards, createdAt } = rewardCache
    const expired = createdAt + staleIn < Date.now()
    if (expired) updateCachedRewards(models).catch(console.error)
    return rewards // serve stale rewards
  }
  return await updateCachedRewards(models)
}

// Sum CONFIRMED platform-wallet inflow by source over [periodStart, periodEnd)
// through the shared reader (api/monero/rewardsInflow.js), so the covering
// distribution's source pie can never drift from the distributor's settlement
// window, walletReceipt eligibility or the exact mixed-rollover reward field.
async function getActiveRewards (models) {
  const { poolPiconeros, rewardsInflowPiconeros, rolledOverPiconeros, time, sources } = await getNextRewardsPool(models)
  // The next distribution's pool = this cycle's rewards earmark + the prior
  // cycle's rollover (rewardsDistributor: poolPiconeros = rewardsInflow +
  // lastDistribution.rolledOverPiconeros). Surface the rollover as a source so
  // the pool shown on /rewards and transparency reflects the FULL rewards
  // reserve, including funds held for future capped weekly distributions.
  if (rolledOverPiconeros > 0n) {
    return [{ total: poolPiconeros, time, sources: [...sources, { name: 'rolled over', value: rolledOverPiconeros.toString() }] }]
  }
  return [{ total: rewardsInflowPiconeros, time, sources }]
}

async function getRewards (when, models) {
  if (when.length > 1) {
    throw new GqlInputError('too many dates')
  }
  for (const w of when) {
    if (isNaN(new Date(w))) {
      throw new GqlInputError('invalid date')
    }
  }

  const config = await models.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  // `when[0]` is 'YYYY-MM-DD'; Date parses a date-only ISO string as UTC midnight.
  const d = new Date(when[0])

  // Covering distribution = the most recent one whose period started at or before
  // the requested date. For any date after the first distribution began, this is
  // the latest distribution overall (so the current week shows last week's
  // payout); future dates still 404 via the page's `time` future-guard (time = d).
  const covering = await models.rewardDistribution.findFirst({
    where: { periodStart: { lte: d } },
    orderBy: { periodEnd: 'desc' }
  })

  if (covering) {
    // Same reader/window as the distributor that created the covering row.
    const inflow = await readRewardsInflow(models, { start: covering.periodStart, end: covering.periodEnd, config })
    const { sources } = rewardsFromInflow(inflow.raw, d, config)
    return [{
      total: covering.distributedPiconeros,
      time: d,
      sources,
      periodStart: covering.periodStart,
      periodEnd: covering.periodEnd
    }]
  }

  // Pre-first-distribution fallback: the requested UTC day's confirmed inflow,
  // read through the same shared reader.
  const inflow = await readRewardsInflow(models, { start: d, end: new Date(d.getTime() + DAY_MS), config })
  return [rewardsFromInflow(inflow.raw, d, config)]
}

export default {
  Query: {
    rewards: async (parent, { when }, { models }) =>
      when ? await getRewards(when, models) : await getCachedActiveRewards(10000, models),
    meRewards: async (parent, { when }, { me, models }) => {
      if (!me) {
        return null
      }
      if (!when || when.length > 1) {
        throw new GqlInputError('too many dates')
      }
      for (const w of when) {
        if (isNaN(new Date(w))) {
          throw new GqlInputError('invalid date')
        }
      }

      const d = new Date(when[0])
      const covering = await models.rewardDistribution.findFirst({
        where: { periodStart: { lte: d } },
        orderBy: { periodEnd: 'desc' }
      })
      if (!covering) return []

      const rows = await models.$queryRaw`
        SELECT coalesce(sum(piconeros), 0) as total,
               json_agg(json_build_object('type', type, 'rank', rank, 'piconeros', piconeros::text, 'typeId', "typeId")) as rewards
        FROM "Earn"
        WHERE "Earn"."userId" = ${me.id}
          AND (type IS NULL OR type NOT IN ('FOREVER_REFERRAL', 'ONE_DAY_REFERRAL'))
          AND "Earn"."distributionId" = ${covering.id}
        GROUP BY "Earn"."distributionId"`
      return rows.map(r => ({ ...r, total: BigInt(r.total.toString()) }))
    }
  },
  Rewards: {
    total: async (parent, args, { models }) => {
      if (!parent.total) {
        return 0
      }
      return parent.total
    },
    // array_agg over an empty result set yields NULL; default to [] for the non-null schema field
    sources: (parent) => parent.sources ?? []
  },
  Mutation: {
    donateToRewards: async (parent, { piconeros, rewardsPct, sendProtocolId }, { me, models }) => {
      await validateSchema(amountSchema, { amount: piconeros })
      if (rewardsPct != null && (!Number.isInteger(rewardsPct) || rewardsPct < 0 || rewardsPct > 100)) {
        throw new GqlInputError('rewardsPct must be an integer between 0 and 100')
      }

      return await pay('DONATE', { piconeros, rewardsPct }, { me, models, sendProtocolId })
    }
  },
  Reward: {
    item: async (reward, args, { me, models }) => {
      if (!reward.typeId) {
        return null
      }

      return getItem(reward, { id: reward.typeId }, { me, models })
    }
  }
}
