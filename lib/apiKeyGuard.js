import { GqlAuthorizationError } from '@/lib/error'

// Mutations an API key may NOT call. API keys exist for automation; they must
// not be able to change credentials, identity, wallets, or move money. New
// sensitive mutations must be added HERE (single source of truth) — the
// per-resolver `assertApiKeyNotPermitted` calls remain as defense in depth.
// Deliberately NOT listed: content/moderation actions (upsertLink,
// upsertDiscussion, upsertComment, deleteItem, deleteComment, vote, etc.),
// which are the intended API-key use case.
export const API_KEY_BLOCKED_MUTATIONS = new Set([
  'act',
  'unlinkAuth',
  'generateApiKey',
  'deleteApiKey',
  'setApiKeyEnabled',
  'setName',
  'setSettings',
  'registerMoneroAccount',
  'unregisterMoneroAccount',
  'initiateTip',
  'useBoostCredit',
  'fundBounty',
  'payBounty',
  'reclaimBounty',
  'rolloverBounty',
  'createInvite',
  'revokeInvite',
  'linkPhrase',
  'createAuth',
  'transferTerritory',
  'setDomain',
  'retryPayIn',
  'paySub',
  'donateToRewards',
  'pollVote',
  'upsertSub',
  'unarchiveTerritory',
  'savePushSubscription',
  'deletePushSubscription',
  'setPhoto',
  'cropPhoto',
  'updateNoteId'
])

export function isApiKeyBlocked ({ me, parentTypeName, fieldName }) {
  return Boolean(me?.apiKey) &&
    parentTypeName === 'Mutation' &&
    API_KEY_BLOCKED_MUTATIONS.has(fieldName)
}

export function apiKeyGuardPlugin () {
  return {
    requestDidStart () {
      return {
        executionDidStart () {
          return {
            willResolveField ({ contextValue, info }) {
              if (isApiKeyBlocked({
                me: contextValue?.me,
                parentTypeName: info.parentType?.name,
                fieldName: info.fieldName
              })) {
                throw new GqlAuthorizationError('this operation is not allowed to be performed via API Key')
              }
            }
          }
        }
      }
    }
  }
}
