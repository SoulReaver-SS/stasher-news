import { gql } from 'graphql-tag'

export default gql`
  extend type Query {
    rewards(when: [String!]): [Rewards!]
    meRewards(when: [String!]!): [MeRewards]
    curatorBudget: CuratorBudget!
  }

  # Live projection of this week's dynamic curator budget (spec §10). It is
  # final at the Monday 00:00 UTC distribution. No tipper identities or config
  # exclusion IDs are exposed: every stage is a total.
  type CuratorBudget {
    mode: String!                 # LEGACY | SHADOW | ACTIVE (effective config)
    fallbackBudgetPiconeros: BigInt! # min(pool, 0.2 XMR cap); the cap is the upper bound while the pool is unavailable
    projectedPiconeros: BigInt    # dynamic projection; NULL when unavailable
    multBps: Int                  # EFFECTIVE multiple (budget x 10000 / T4); NULL when T4 = 0 or unavailable
    targetMultBps: Int!
    t4Piconeros: BigInt
    targetPiconeros: BigInt       # this week's target: k x T4 + approved make-up; NULL when unavailable
    reservePiconeros: BigInt      # max(pool - I4, 0); NULL when unavailable
    spendLimitPiconeros: BigInt   # (I4 + reserve / W) x 10000 / 11000; NULL when unavailable
    drawdownWeeks: Int            # the W the copy must quote (ledger default 13, valid 4..104); NULL when unavailable
    dynamicBudgetMode: String     # FULL | DRAWDOWN | POOL_SHORT for the live projection; NULL when unavailable
    windingDown: Boolean!         # the last two recorded runs both ended in DRAWDOWN (spec §10)
    breakerTripped: Boolean!
  }

  extend type Mutation {
    donateToRewards(piconeros: BigInt!, rewardsPct: Int, sendProtocolId: Int): PayIn!
  }

  type DonateResult {
    piconeros: BigInt!
  }

  type Rewards {
    total: BigInt!
    time: Date!
    sources: [NameValue!]!
    periodStart: Date
    periodEnd: Date
  }

  type Reward {
    type: String
    rank: Int
    piconeros: BigInt!
    item: Item
  }

  type MeRewards {
    total: BigInt!
    rewards: [Reward!]
  }
`
