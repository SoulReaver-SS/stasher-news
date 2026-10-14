import gql from 'graphql-tag'
import { ITEM_FULL_FIELDS } from './items'
import { SUB_FULL_FIELDS } from './subs'
import { COMMENTS } from './comments'
import { INVITE_FIELDS } from './invites'

const HASH_HMAC_INPUT_1 = '$hash: String, $hmac: String'
const HASH_HMAC_INPUT_2 = 'hash: $hash, hmac: $hmac'

export const PAY_IN_LINK_FIELDS = gql`
  fragment PayInLinkFields on PayIn {
    id
    piconeros
    payInType
    payInState
    payInStateChangedAt
    payerPrivates {
      payInFailureReason
      retryCount
    }
  }
`

export const PAY_IN_WALLET_INFO_FIELDS = gql`
  fragment PayInWalletInfoFields on PayInWalletInfo {
    walletId
    walletName
    protocolId
    protocolName
    role
  }
`

export const PAY_IN_FIELDS = gql`
  ${SUB_FULL_FIELDS}
  ${COMMENTS}
  ${PAY_IN_LINK_FIELDS}
  fragment PayInFields on PayIn {
    id
    createdAt
    updatedAt
    piconeros
    moneroUri
    paymentId
    payInType
    payInState
    payInStateChangedAt
    payerPrivates {
      userId
      payInFailureReason
      retryCount
      pessimisticEnv {
        id
        error
        result
      }
      payInCustodialTokens {
        id
        mtokens
        custodialTokenType
      }
      result {
        __typename
        ... on Item {
          id
          deleteScheduledAt
          reminderScheduledAt
          ...CommentFields
          payIn {
            ...PayInLinkFields
          }
        }
        ... on ItemAct {
          id
          piconeros
          path
          act
          payIn {
            ...PayInLinkFields
          }
        }
        ... on PollVote {
          id
          payIn {
            ...PayInLinkFields
          }
        }
        ... on Sub {
          ...SubFullFields
        }
      }
    }
  }
`

export const PAY_IN_STATISTICS_FIELDS = gql`
  ${ITEM_FULL_FIELDS}
  ${SUB_FULL_FIELDS}
  ${INVITE_FIELDS}
  fragment PayInStatisticsFields on PayIn {
    id
    createdAt
    updatedAt
    piconeros
    isSend
    payInType
    payInState
    payInStateChangedAt
    genesisId
    payerPrivates {
      userId
      payInFailureReason
      retryCount
      payInCustodialTokens {
        id
        mtokens
        mtokensAfter
        custodialTokenType
      }
      refundCustodialTokens {
        id
        mtokens
        mtokensAfter
        custodialTokenType
      }
      invite {
        ...InviteFields
      }
      sub {
        ...SubFullFields
      }
    }
    payOutCustodialTokens {
      id
      payOutType
      mtokens
      privates {
        mtokensAfter
      }
      sometimesPrivates {
        user {
          name
        }
      }
      custodialTokenType
      sub {
        name
      }
    }
    item {
      ...ItemFullFields
    }
  }
`

export const STATISTICS = gql`
  ${PAY_IN_STATISTICS_FIELDS}
  query Statistics($cursor: String, $walletId: ID) {
    statistics(cursor: $cursor, walletId: $walletId) {
      payIns {
        ...PayInStatisticsFields
      }
      cursor
    }
  }
`

// Used by SSR so the transaction page has viewer-scoped wallet info on first render.
export const GET_PAY_IN_FULL_WITH_WALLET_INFO = gql`
  ${PAY_IN_STATISTICS_FIELDS}
  ${PAY_IN_WALLET_INFO_FIELDS}
  query payIn($id: Int!) {
    payIn(id: $id) {
      ...PayInStatisticsFields
      walletInfo {
        ...PayInWalletInfoFields
      }
    }
  }
`

// Used for polling so we do not re-resolve walletInfo on every refresh.
export const GET_PAY_IN_FULL_WITHOUT_WALLET_INFO = gql`
  ${PAY_IN_STATISTICS_FIELDS}
  query payIn($id: Int!) {
    payIn(id: $id) {
      ...PayInStatisticsFields
    }
  }
`

export const GET_PAY_IN_RESULT = gql`
  ${PAY_IN_FIELDS}
  query payIn($id: Int!) {
    payIn(id: $id) {
      ...PayInFields
    }
  }
`

export const RETRY_PAY_IN = gql`
  ${PAY_IN_FIELDS}
  mutation retryPayIn($payInId: Int!, $sendProtocolId: Int) {
    retryPayIn(payInId: $payInId, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }
`

export const FAILED_PAY_INS = gql`
  query failedPayIns {
    failedPayIns {
      id
    }
  }
`

export const DONATE = gql`
  ${PAY_IN_FIELDS}
  mutation donateToRewards($piconeros: BigInt!, $rewardsPct: Int, $sendProtocolId: Int) {
    donateToRewards(piconeros: $piconeros, rewardsPct: $rewardsPct, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const ACT_MUTATION = gql`
  ${PAY_IN_FIELDS}
  mutation act($id: ID!, $piconeros: BigInt!, $act: String) {
    act(id: $id, piconeros: $piconeros, act: $act) {
      ...PayInFields
    }
  }`

export const UPSERT_DISCUSSION = gql`
  ${PAY_IN_FIELDS}
  mutation upsertDiscussion($subNames: [String!]!, $id: ID, $title: String!, $text: String,
    $moneroWallPricePiconeros: BigInt, $moneroWallThresholdPiconeros: BigInt, $moneroWallCoversComments: Boolean,
    ${HASH_HMAC_INPUT_1}, $sendProtocolId: Int) {
    upsertDiscussion(subNames: $subNames, id: $id, title: $title, text: $text,
      moneroWallPricePiconeros: $moneroWallPricePiconeros, moneroWallThresholdPiconeros: $moneroWallThresholdPiconeros, moneroWallCoversComments: $moneroWallCoversComments,
      ${HASH_HMAC_INPUT_2}, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const REPOST_ITEM = gql`
  ${PAY_IN_FIELDS}
  mutation repostItem($id: ID!, $subName: String!) {
    repostItem(id: $id, subName: $subName) {
      ...PayInFields
    }
  }`

export const UPSERT_JOB = gql`
  ${PAY_IN_FIELDS}
  mutation upsertJob($subNames: [String!]!, $id: ID, $title: String!, $company: String!,
    $location: String, $remote: Boolean, $text: String!, $url: String!,
    $status: String, $logo: Int, $sendProtocolId: Int) {
    upsertJob(subNames: $subNames, id: $id, title: $title, company: $company,
      location: $location, remote: $remote, text: $text,
      url: $url, status: $status, logo: $logo, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UPSERT_LINK = gql`
  ${PAY_IN_FIELDS}
  mutation upsertLink($subNames: [String!]!, $id: ID, $title: String!, $url: String!,
    $text: String, $moneroWallPricePiconeros: BigInt, $moneroWallThresholdPiconeros: BigInt, $moneroWallCoversComments: Boolean,
    ${HASH_HMAC_INPUT_1}, $sendProtocolId: Int) {
    upsertLink(subNames: $subNames, id: $id, title: $title, url: $url, text: $text,
      moneroWallPricePiconeros: $moneroWallPricePiconeros, moneroWallThresholdPiconeros: $moneroWallThresholdPiconeros, moneroWallCoversComments: $moneroWallCoversComments,
      ${HASH_HMAC_INPUT_2}, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UPSERT_POLL = gql`
  ${PAY_IN_FIELDS}
  mutation upsertPoll($subNames: [String!]!, $id: ID, $title: String!, $text: String,
    $options: [String!]!, $pollExpiresAt: Date,
    $randPollOptions: Boolean, ${HASH_HMAC_INPUT_1}, $sendProtocolId: Int) {
    upsertPoll(subNames: $subNames, id: $id, title: $title, text: $text,
      options: $options, pollExpiresAt: $pollExpiresAt,
      randPollOptions: $randPollOptions, ${HASH_HMAC_INPUT_2}, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UPSERT_BOUNTY = gql`
  ${PAY_IN_FIELDS}
  mutation upsertBounty($subNames: [String!]!, $id: ID, $title: String!, $bountyPiconeros: BigInt,
    $text: String, $moneroWallPricePiconeros: BigInt, $moneroWallThresholdPiconeros: BigInt, $moneroWallCoversComments: Boolean,
    $sendProtocolId: Int) {
    upsertBounty(subNames: $subNames, id: $id, title: $title, bountyPiconeros: $bountyPiconeros, text: $text,
      moneroWallPricePiconeros: $moneroWallPricePiconeros, moneroWallThresholdPiconeros: $moneroWallThresholdPiconeros, moneroWallCoversComments: $moneroWallCoversComments,
      sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

// StasherNews bounty lifecycle (A-13). fundBounty mints the escrow integrated
// address + monero: URI; payBounty (award), reclaimBounty and rolloverBounty
// queue the escrow payouts the worker dispatches.
export const FUND_BOUNTY_MUTATION = gql`
  mutation fundBounty($postId: ID!) {
    fundBounty(postId: $postId) {
      uri
      integratedAddress
      paymentId
      feePiconeros
      receivedPiconeros
      expectedPiconeros
    }
  }`

export const AWARD_BOUNTY_MUTATION = gql`
  mutation awardBounty($id: ID!, $winnerCommentId: ID!) {
    payBounty(id: $id, winnerCommentId: $winnerCommentId) {
      id
      kind
      state
      piconeros
    }
  }`

export const RECLAIM_BOUNTY_MUTATION = gql`
  mutation reclaimBounty($id: ID!) {
    reclaimBounty(id: $id) {
      id
      kind
      state
      piconeros
    }
  }`

export const ROLLOVER_BOUNTY_MUTATION = gql`
  mutation rolloverBounty($id: ID!) {
    rolloverBounty(id: $id) {
      id
      kind
      state
      piconeros
    }
  }`

export const POLL_VOTE = gql`
  ${PAY_IN_FIELDS}
  mutation pollVote($id: ID!, $sendProtocolId: Int) {
    pollVote(id: $id, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UPSERT_BIO = gql`
  ${PAY_IN_FIELDS}
  mutation upsertBio($text: String!, $sendProtocolId: Int) {
    upsertBio(text: $text, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const CREATE_COMMENT = gql`
  ${PAY_IN_FIELDS}
  mutation upsertComment($text: String!, $parentId: ID!, $sendProtocolId: Int) {
    upsertComment(text: $text, parentId: $parentId, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UPDATE_COMMENT = gql`
  ${PAY_IN_FIELDS}
  mutation upsertComment($id: ID!, $text: String!, ${HASH_HMAC_INPUT_1}, $sendProtocolId: Int) {
    upsertComment(id: $id, text: $text, ${HASH_HMAC_INPUT_2}, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UPSERT_SUB = gql`
  ${PAY_IN_FIELDS}
  mutation upsertSub($oldName: String, $name: String!, $desc: String,
    $postsPiconerosFilter: BigInt,
    $postPremiumPiconeros: BigInt, $commentPremiumPiconeros: BigInt,
    $postTypes: [String!]!, $billingType: String!,
    $billingAutoRenew: Boolean!, $nsfw: Boolean!, $sendProtocolId: Int) {
      upsertSub(oldName: $oldName, name: $name, desc: $desc,
        postsPiconerosFilter: $postsPiconerosFilter,
        postPremiumPiconeros: $postPremiumPiconeros,
        commentPremiumPiconeros: $commentPremiumPiconeros,
        postTypes: $postTypes, billingType: $billingType,
        billingAutoRenew: $billingAutoRenew, nsfw: $nsfw, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const UNARCHIVE_TERRITORY = gql`
  ${PAY_IN_FIELDS}
  mutation unarchiveTerritory($name: String!, $desc: String,
    $postsPiconerosFilter: BigInt,
    $postPremiumPiconeros: BigInt, $commentPremiumPiconeros: BigInt,
    $postTypes: [String!]!, $billingType: String!,
    $billingAutoRenew: Boolean!, $nsfw: Boolean!, $sendProtocolId: Int) {
      unarchiveTerritory(name: $name, desc: $desc,
        postsPiconerosFilter: $postsPiconerosFilter,
        postPremiumPiconeros: $postPremiumPiconeros,
        commentPremiumPiconeros: $commentPremiumPiconeros,
        postTypes: $postTypes, billingType: $billingType,
        billingAutoRenew: $billingAutoRenew, nsfw: $nsfw, sendProtocolId: $sendProtocolId) {
      ...PayInFields
    }
  }`

export const SUB_PAY = gql`
  ${PAY_IN_FIELDS}
  mutation paySub($name: String!, $sendProtocolId: Int) {
    paySub(name: $name, sendProtocolId: $sendProtocolId) {
      ...PayInFields
      receivedPiconeros
      expectedPiconeros
    }
  }`
