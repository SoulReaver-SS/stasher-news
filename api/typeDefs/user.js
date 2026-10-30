import { gql } from 'graphql-tag'
import { LIMIT } from '@/lib/cursor'

export default gql`
  extend type Query {
    me: User
    settings: User
    user(id: ID, name: String): User
    nameAvailable(name: String!): Boolean!
    topUsers(cursor: String, when: String, from: String, to: String, by: String, limit: Limit! = ${LIMIT}): UsersNullable!
    topCowboys(cursor: String): UsersNullable!
    searchUsers(q: String!, limit: Limit! = 5, similarity: Float): [User!]!
    userSuggestions(q: String, limit: Limit! = 5): [User!]!
    hasNewNotes: Boolean!
    mySubscribedUsers(cursor: String): Users!
    myMutedUsers(cursor: String): Users!
  }

  type UsersNullable {
    cursor: String
    users: [User]!
  }

  type Users {
    cursor: String
    users: [User!]!
  }

  input CropData {
    x: Float!
    y: Float!
    width: Float!
    height: Float!
    originalWidth: Int!
    originalHeight: Int!
    scale: Float!
  }

  extend type Mutation {
    setName(name: String!): String
    setSettings(settings: SettingsInput!): User
    cropPhoto(photoId: ID!, cropData: CropData): String!
    setPhoto(photoId: ID!): Int!
    upsertBio(text: String!, sendProtocolId: Int): PayIn!
    setWalkthrough(tipPopover: Boolean, upvotePopover: Boolean): Boolean
    unlinkAuth(authType: String!, lastAuthConfirm: Boolean): AuthMethods!
    subscribeUserPosts(id: ID): User
    subscribeUserComments(id: ID): User
    toggleMute(id: ID): User
    generateApiKey(id: ID!): String
    deleteApiKey(id: ID!): User
  }

  type User {
    id: ID!
    createdAt: Date!
    name: String!
    nitems(when: String, from: String, to: String): Int!
    nterritories(when: String, from: String, to: String): Int!
    bio: Item
    bioId: Int
    photoId: Int
    since: Int

    """
    this is only returned when we sort stackers by value
    """
    proportion: Float

    optional: UserOptional!
    privates: UserPrivates

    meMute: Boolean!
    meSubscriptionPosts: Boolean!
    meSubscriptionComments: Boolean!

    """
    whether this user may generate an API key; only returned to admins, null otherwise
    """
    apiKeyEnabled: Boolean
  }

  input SettingsInput {
    noReferralLinks: Boolean!
    fiatCurrency: String!
    postsPiconerosFilter: BigInt
    commentsPiconerosFilter: BigInt
    hideBookmarks: Boolean!
    hideBadges: Boolean!
    hideGithub: Boolean!
    hideNostr: Boolean!
    hideTwitter: Boolean!
    hideFromTopUsers: Boolean!
    hideStashAmount: Boolean!
    imgproxyOnly: Boolean!
    showImagesAndVideos: Boolean!
    nostrCrossposting: Boolean!
    nostrPubkey: String
    nostrRelays: [String!]
    noteAllDescendants: Boolean!
    noteBadges: Boolean!
    noteQuests: Boolean!
    noteEarning: Boolean!
    emailNotifications: Boolean!
    newsletterOptIn: Boolean!
    noteInvites: Boolean!
    noteItemPiconeros: Boolean!
    noteMentions: Boolean!
    noteItemMentions: Boolean!
    nsfwMode: Boolean!
    tipDefault: BigInt!
    tipRandomMin: BigInt
    tipRandomMax: BigInt
  }

  type AuthMethods {
    lightning: Boolean!
    nostr: Boolean!
    github: Boolean!
    twitter: Boolean!
    email: Boolean!
    emailHint: String
    phrase: Boolean!
    phraseFingerprint: String
    apiKey: Boolean
    enabled: [String!]!
  }

  type UserPrivates {
    """
    extremely sensitive
    """
    piconeros: BigInt!
    credits: Int!
    authMethods: AuthMethods!
    freeCommentCount: Int!
    freeCommentsLeft: Int!
    freeCommentsQuota: Int!
    freeReplyCredits: Int!
    questUpvoteComplete: Boolean!
    questDrawnType: String!
    questDrawnComplete: Boolean!
    questsCompletedToday: Int!
    flameCycleDay: Int!
    flameWeek: Int!
    goldFlame: Boolean!
    turfDiscountHeld: Boolean!

    """
    the held flame boost credit, if one is available (unconsumed, unexpired)
    """
    boostCreditId: ID
    boostCreditExpiresAt: Date
    questResetsAt: Date!
    freePostCount: Int!
    freePostsLeft: Int!
    freePostsQuota: Int!
    freePostCredits: Int!
    freePostCreditsExpireAt: Date
    postingFeeRequired: Boolean!
    postingFeePiconeros: BigInt!
    postingFeeFloorPiconeros: BigInt!
    freePostThresholdPiconeros: BigInt!
    freePostMinAgeDays: Int!
    territoryMonthlyPiconeros: BigInt!
    territoryYearlyPiconeros: BigInt!
    territoryOncePiconeros: BigInt!
    commentFeePiconeros: BigInt!

    """
    whether turf owner fee routing (TURF_OWNER_FEES) is enabled platform-wide
    """
    turfOwnerFees: Boolean!

    """
    only relevant to user
    """
    tipPopover: Boolean!
    upvotePopover: Boolean!
    hasInvites: Boolean!
    apiKeyEnabled: Boolean!
    diagnostics: Boolean! @deprecated(reason: "Compatibility shim")

    """
    mirrors SettingsInput
    """
    noReferralLinks: Boolean!
    fiatCurrency: String!
    postsPiconerosFilter: BigInt
    commentsPiconerosFilter: BigInt
    hideBookmarks: Boolean!
    hideBadges: Boolean!
    hideGithub: Boolean!
    hideNostr: Boolean!
    hideTwitter: Boolean!
    hideFromTopUsers: Boolean!
    hideStashAmount: Boolean!
    imgproxyOnly: Boolean!
    showImagesAndVideos: Boolean!
    nostrCrossposting: Boolean!
    nostrPubkey: String
    nostrRelays: [String!]
    noteAllDescendants: Boolean!
    noteBadges: Boolean!
    noteQuests: Boolean!
    noteEarning: Boolean!
    emailNotifications: Boolean!
    newsletterOptIn: Boolean!
    noteInvites: Boolean!
    noteItemPiconeros: Boolean!
    noteMentions: Boolean!
    noteItemMentions: Boolean!
    nsfwMode: Boolean!
    tipDefault: BigInt!
    tipRandom: Boolean!
    tipRandomMin: BigInt
    tipRandomMax: BigInt
    autoWithdrawThreshold: Int
  }

  type UserOptional {
    """
    conditionally private
    """
    stacked(when: String, from: String, to: String): BigInt
    spent(when: String, from: String, to: String): BigInt
    referrals(when: String, from: String, to: String): Int
    stashAmountHidden: Boolean!
    streak: Int
    goldFlame: Boolean!
    hasWallet: Boolean
    maxStreak: Int
    isContributor: Boolean
    githubId: String
    twitterId: String
    nostrAuthPubkey: String
  }

  type NameValue {
    name: String!
    value: BigInt!
  }

  type TimeData {
    time: Date!
    data: [NameValue!]!
  }
`
