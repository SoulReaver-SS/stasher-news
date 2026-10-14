import { gql } from '@apollo/client'
import { STREAK_FIELDS } from './streak-fields'
import { ITEM_ADDENDUM_FIELDS } from './item-addendum'

export const COMMENT_FIELDS = gql`
  ${STREAK_FIELDS}
  ${ITEM_ADDENDUM_FIELDS}
  fragment CommentFields on Item {
    id
    position
    parentId
    createdAt
    deletedAt
    text
    # true when this reply sits under a monerowalled discussion the viewer
    # hasn't unlocked — the server serves null text; render the placeholder
    commentWalled
    lexicalState
    html
    editMode
    editExpiresAt
    ...ItemAddendumFields
    bountyAwardedAt
    user {
      id
      name
      meMute
      ...StreakFields
    }
    payIn {
      id
      payInState
      payInType
      moneroUri
      payInStateChangedAt
      payerPrivates {
        payInFailureReason
        retryCount
      }
    }
    piconeros
    credits
    meAnonPiconeros @client
    upvotes
    freedFreebie
    boost
    downPiconeros
    commentDownPiconeros
    mePiconeros
    meDontLikePiconeros
    meBookmark
    meSubscription
    freebie
    netInvestment
    path
    commentPiconeros
    commentCost
    commentBoost
    mine
    otsHash
    ncomments
    nDirectComments
    live @client
    imgproxyUrls
    xPreview
    rel
    apiKey
    cost
    feeStatus
    feeReceivedPiconeros
  }
`

export const COMMENT_FIELDS_NO_CHILD_COMMENTS = gql`
  ${STREAK_FIELDS}
  ${ITEM_ADDENDUM_FIELDS}
  fragment CommentFieldsNoChildComments on Item {
    id
    position
    parentId
    createdAt
    deletedAt
    text
    # true when this reply sits under a monerowalled discussion the viewer
    # hasn't unlocked — the server serves null text; render the placeholder
    commentWalled
    lexicalState
    html
    editMode
    editExpiresAt
    ...ItemAddendumFields
    user {
      id
      name
      meMute
      ...StreakFields
    }
    payIn {
      id
      payInState
      payInType
      moneroUri
      payInStateChangedAt
      payerPrivates {
        payInFailureReason
        retryCount
      }
    }
    piconeros
    credits
    meAnonPiconeros @client
    upvotes
    freedFreebie
    boost
    downPiconeros
    commentDownPiconeros
    mePiconeros
    meDontLikePiconeros
    meBookmark
    meSubscription
    freebie
    netInvestment
    path
    commentPiconeros
    commentCost
    commentBoost
    mine
    otsHash
    live @client
    imgproxyUrls
    xPreview
    rel
    apiKey
    cost
    feeStatus
    feeReceivedPiconeros
  }
`

export const COMMENTS_ITEM_EXT_FIELDS = gql`
  ${STREAK_FIELDS}
  fragment CommentItemExtFields on Item {
    text
    lexicalState
    html
    bountyAwardedAt
    root {
      id
      title
      bounty
      ncomments
      bountyPaidTo
      bountyStatus
      bountyPiconeros
      subNames
      subs {
        name
        userId
        meMuteSub
      }
      user {
        name
        id
        ...StreakFields
      }
    }
  }`

// we only get the first COMMENT_DEPTH_LIMIT comments
export const COMMENTS = gql`
  ${COMMENT_FIELDS}

  fragment CommentsRecursive on Item {
    ...CommentFields
    comments {
      comments {
        ...CommentFields
        comments {
          comments {
            ...CommentFields
            comments {
              comments {
                ...CommentFields
                comments {
                  comments {
                    ...CommentFields
                    comments {
                      comments {
                        ...CommentFields
                        comments {
                          comments {
                            ...CommentFields
                            comments {
                              comments {
                                ...CommentFields
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`

export const HAS_COMMENTS = gql`
  fragment HasComments on Item {
    comments
  }
`

export const GET_NEW_COMMENTS = gql`
  ${COMMENT_FIELDS_NO_CHILD_COMMENTS}

  query GetNewComments($itemId: ID, $after: Date) {
    newComments(itemId: $itemId, after: $after) {
      comments {
        ...CommentFieldsNoChildComments
      }
    }
  }
`
