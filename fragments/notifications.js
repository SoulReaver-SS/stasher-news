import { gql } from '@apollo/client'
import { ITEM_FULL_FIELDS, POLL_FIELDS } from './items'
import { INVITE_FIELDS } from './invites'
import { SUB_FIELDS } from './subs'
import { PAY_IN_LINK_FIELDS } from './payIn'
export const HAS_NOTIFICATIONS = gql`{ hasNewNotes }`
export const HAS_NOTIFICATIONS_AFTER_VIEW = gql`
  query HasNewNotesAfterView($viewedItemId: ID!) {
    hasNewNotes(viewedItemId: $viewedItemId)
  }`

export const PAY_INIFICATION = gql`
  ${ITEM_FULL_FIELDS}
  ${POLL_FIELDS}
  ${PAY_IN_LINK_FIELDS}
  fragment PayInificationFields on PayInification {
    id
    sortTime
    earnedPiconeros
    payInItem {
      ...ItemFullFields
      ...PollFields
    }
    payIn {
      ...PayInLinkFields
    }
  }`

export const NOTIFICATIONS = gql`
  ${PAY_INIFICATION}
  ${INVITE_FIELDS}
  ${SUB_FIELDS}

  query Notifications($cursor: String, $inc: String) {
    notifications(cursor: $cursor, inc: $inc) {
      cursor
      lastChecked
      notifications {
        __typename
        ... on Mention {
          id
          sortTime
          mention
          item {
            ...ItemFullFields
            text
          }
        }
        ... on ItemMention {
          id
          sortTime
          item {
            ...ItemFullFields
            text
          }
        }
        ... on Votification {
          id
          sortTime
          earnedPiconeros
          item {
            ...ItemFullFields
            text
          }
        }
        ... on BountyPayment {
          id
          sortTime
          earnedPiconeros
          item {
            ...ItemFullFields
            text
          }
        }
        ... on Revenue {
          id
          sortTime
          earnedPiconeros
          subName
        }
        ... on Flame {
          id
          sortTime
          days
        }
        ... on NewVerified {
          id
          sortTime
        }
        ... on QuestComplete {
          id
          sortTime
          quest
        }
        ... on FlameDay {
          id
          sortTime
          day
        }
        ... on Bulletinification {
          id
          sortTime
          bulletin {
            title
            text
            lexicalState
            html
            iconType
          }
        }
        ... on Earn {
          id
          sortTime
          minSortTime
          earnedPiconeros
          sources {
            posts
            comments
            tipPosts
            tipComments
          }
        }
        ... on ReferralReward {
          id
          sortTime
          earnedPiconeros
          sources {
            forever
            oneDay
          }
        }
        ... on Referral {
          id
          sortTime
          source {
            __typename
            ... on Item {
              ...ItemFullFields
            }
            ... on Sub {
              ...SubFields
            }
            ... on User {
              name
            }
          }
        }
        ... on Reply {
          id
          sortTime
          item {
            ...ItemFullFields
            text
          }
        }
        ... on FollowActivity {
          id
          sortTime
          item {
            ...ItemFullFields
            text
          }
        }
        ... on TerritoryPost {
          id
          sortTime
          item {
            ...ItemFullFields
            text
          }
        }
        ... on TerritoryTransfer {
          id
          sortTime
          sub {
            ...SubFields
          }
        }
        ... on Invitification {
          id
          sortTime
          invite {
            ...InviteFields
          }
        }
        ... on JobChanged {
          id
          sortTime
          item {
            ...ItemFields
          }
        }
        ... on SubStatus {
          id
          sortTime
          sub {
            ...SubFields
          }
        }
        ... on PayInification {
          ...PayInificationFields
        }
        ... on Reminder {
          id
          sortTime
          item {
            ...ItemFullFields
          }
        }
      }
    }
  } `
