import { gql } from 'graphql-tag'
import { LIMIT } from '@/lib/cursor'

export default gql`
  extend type Query {
    items(sub: String, sort: String, type: String, cursor: String, name: String, when: String, from: String, to: String, by: String, limit: Limit! = ${LIMIT}): Items
    item(id: ID!): Item
    pageTitleAndUnshorted(url: String!): TitleUnshorted
    dupes(url: String!): [Item!]
    related(cursor: String, title: String, id: ID, minMatch: String, limit: Limit! = ${LIMIT}): Items
    search(q: String, cursor: String, what: String, sort: String, when: String, from: String, to: String): Items
    itemRepetition(parentId: ID): Int!
    newComments(itemId: ID, after: Date): Comments!
  }

  type TitleUnshorted {
    title: String
    unshorted: String
  }

  extend type Mutation {
    bookmarkItem(id: ID): Item
    pinItem(id: ID): Item
    subscribeItem(id: ID): Item
    deleteItem(id: ID): Item
    upsertLink(
      id: ID, subNames: [String!], title: String!, url: String!, text: String,
      moneroWallPricePiconeros: BigInt, moneroWallThresholdPiconeros: BigInt, moneroWallCoversComments: Boolean,
      hash: String, hmac: String, sendProtocolId: Int): PayIn!
    upsertDiscussion(
      id: ID, subNames: [String!], title: String!, text: String,
      moneroWallPricePiconeros: BigInt, moneroWallThresholdPiconeros: BigInt, moneroWallCoversComments: Boolean,
      hash: String, hmac: String, sendProtocolId: Int): PayIn!
    upsertBounty(
      id: ID, subNames: [String!], title: String!, text: String, bountyPiconeros: BigInt,
      moneroWallPricePiconeros: BigInt, moneroWallThresholdPiconeros: BigInt, moneroWallCoversComments: Boolean,
      hash: String, hmac: String, sendProtocolId: Int): PayIn!
    removeMoneroWall(id: ID!): Item!
    # one-way lift of the discussion wall only (the post body stays walled)
    openMoneroWallComments(id: ID!): Item!
    rateMoneroWallPost(itemId: ID!, stars: Int!): Item!
    upsertJob(
      id: ID, subNames: [String!], title: String!, company: String!, location: String, remote: Boolean,
      text: String!, url: String!, status: String, logo: Int, sendProtocolId: Int): PayIn!
    upsertPoll(
      id: ID, subNames: [String!], title: String!, text: String, options: [String!]!, pollExpiresAt: Date,
      randPollOptions: Boolean, hash: String, hmac: String, sendProtocolId: Int): PayIn!
    repostItem(id: ID!, subName: String!): PayIn!
    updateNoteId(id: ID!, noteId: String!): Item!
    upsertComment(id: ID, text: String!, parentId: ID, hash: String, hmac: String, sendProtocolId: Int): PayIn!
    act(id: ID!, piconeros: BigInt, act: String): PayIn!
    # Exact-credit boost redemption: spends the caller's held boost
    # credit on one of their own live posts (rank-only promo weight).
    useBoostCredit(itemId: ID!, rewardId: ID!): Item!
    pollVote(id: ID!, sendProtocolId: Int): PayIn!
    updateCommentsViewAt(id: ID!, meCommentsViewedAt: Date!): Date
  }

  type PollOption {
    id: ID,
    option: String!
    count: Int!
  }

  type Poll {
    count: Int!
    options: [PollOption!]!
    randPollOptions: Boolean
    meVoted: Boolean!
  }

  type Items {
    cursor: String
    items: [Item!]!
    pins: [Item!]
    searchSuggestion: String
  }

  type Comments {
    cursor: String
    comments: [Item!]!
  }

  type ItemAct {
    id: ID!
    piconeros: BigInt!
    act: String!
    path: String
    payIn: PayIn
  }

  type PollVote {
    id: ID!
    payIn: PayIn
  }

  enum ItemFeeStatus {
    FEE_NOT_REQUIRED
    PENDING_FEE
    FEE_PAID
  }

  type MoneroWall {
    pricePiconeros: BigInt
    thresholdPiconeros: BigInt
    enabledAt: Date!
    frozen: Boolean!
    publiclyUnlocked: Boolean!
    locked: Boolean!
    # discussion wall (2026-10-14): coversComments is static config,
    # commentsLocked is viewer-relative (coversComments && locked)
    coversComments: Boolean!
    commentsLocked: Boolean!
    myContributionPiconeros: BigInt!
    myRateablePiconeros: BigInt!
    progressPiconeros: BigInt!
    remainingPiconeros: BigInt!
  }

  type MoneroWallRatingAgg {
    average: Float!
    count: Int!
    myStars: Int
    canRate: Boolean!
    # true when the viewer paid >= X at 0-conf but rating depth (3 confs) hasn't arrived yet
    pendingRating: Boolean!
  }

  type Item {
    id: ID!
    createdAt: Date!
    updatedAt: Date!
    deletedAt: Date
    deleteScheduledAt: Date
    reminderScheduledAt: Date
    title: String
    searchTitle: String
    url: String
    searchText: String
    excerpt: String
    text: String
    lexicalState: String
    html: String
    parentId: Int
    parent: Item
    root: Item
    user: User!
    userId: Int!
    depth: Int
    mine: Boolean!
    boost: BigInt!
    # StasherNews: the rank-only promo weight of a redeemed boost credit
    # (spec 2026-10-05-quest-rebalance-boost-credit). Never money: it moves
    # nothing in PayIn, the rewards wallet, or the monetary filters.
    promoBoostPiconeros: BigInt!
    bounty: Int
    bountyPaidTo: [Int]
    noteId: String
    piconeros: BigInt!
    downPiconeros: BigInt!
    credits: Int!
    commentPiconeros: BigInt!
    commentCredits: Int!
    commentCost: Int!
    commentBoost: BigInt!
    commentDownPiconeros: BigInt!
    lastCommentAt: Date
    upvotes: Int!
    mePiconeros: BigInt!
    meCredits: Int!
    meDontLikePiconeros: BigInt!
    meBookmark: Boolean!
    meSubscription: Boolean!
    freebie: Boolean!
    netInvestment: BigInt!
    freedFreebie: Boolean!
    bio: Boolean!
    ncomments: Int!
    nDirectComments: Int!
    comments(sort: String, cursor: String): Comments!
    path: String
    position: Int
    prior: Int
    isJob: Boolean!
    pollCost: Int
    poll: Poll
    pollExpiresAt: Date
    company: String
    location: String
    remote: Boolean
    sub: Sub
    subName: String
    subs: [Sub!]
    subNames: [String!]
    primarySubName: String
    status: String!
    uploadId: Int
    otsHash: String
    parentOtsHash: String
    imgproxyUrls: JSONObject
    xPreview: JSONObject
    rel: String
    apiKey: Boolean
    feeStatus: ItemFeeStatus!
    feeReceivedPiconeros: BigInt!
    # Top-up URI for a PENDING_FEE item: re-quotes only the REMAINDER after a
    # partial fee (mirrors territoryReentryFunding). Null for non-fee items and
    # before any fee PayIn exists. The stored full-fee URI is never rewritten.
    feeTopUpUri: String
    cost: Int!
    payIn: PayIn
    moneroWall: MoneroWall
    moneroWallRating: MoneroWallRatingAgg!
    # true when this item is a comment the viewer cannot read (thread root
    # walls the discussion and the viewer is locked) — drives the placeholder
    commentWalled: Boolean!
    meCommentsViewedAt: Date
  }
`
