/* eslint-env jest */
import { API_KEY_BLOCKED_MUTATIONS, apiKeyGuardPlugin, isApiKeyBlocked } from '@/lib/apiKeyGuard'
import { GqlAuthorizationError } from '@/lib/error'
import typeDefs from '@/api/typeDefs'

const SENSITIVE = [
  'act',
  'unlinkAuth', 'generateApiKey', 'deleteApiKey', 'setApiKeyEnabled', 'setName', 'setSettings',
  'registerMoneroAccount', 'unregisterMoneroAccount', 'initiateTip',
  'fundBounty', 'payBounty', 'reclaimBounty', 'rolloverBounty',
  'createInvite', 'revokeInvite', 'linkPhrase', 'createAuth',
  'transferTerritory', 'setDomain', 'retryPayIn', 'paySub',
  'donateToRewards', 'pollVote', 'upsertSub', 'unarchiveTerritory',
  'savePushSubscription', 'deletePushSubscription', 'setPhoto', 'cropPhoto',
  'updateNoteId'
]

// Every Mutation field the schema declares, minus the `_` sentinel the common
// typeDefs use to keep the root types non-empty.
function schemaMutationNames () {
  const names = new Set()
  for (const doc of typeDefs) {
    for (const def of doc.definitions) {
      const isMutation = (def.kind === 'ObjectTypeDefinition' || def.kind === 'ObjectTypeExtension') &&
        def.name.value === 'Mutation'
      if (!isMutation) continue
      for (const f of def.fields || []) names.add(f.name.value)
    }
  }
  names.delete('_')
  return names
}

// The reviewed classification of every mutation an API key MAY call. The deny
// list in lib/apiKeyGuard.js cannot catch a NEW sensitive mutation by itself,
// so this test makes an unclassified mutation a loud failure instead: adding a
// mutation to the schema breaks these tests until it lands in
// API_KEY_BLOCKED_MUTATIONS (credentials/identity/wallets/money) or here
// (content, moderation, notifications, preferences — the intended API-key use
// cases). Keep the two lists disjoint and both anchored to the schema.
const REVIEWED_NON_SENSITIVE = new Set([
  // content creation / moderation
  'bookmarkItem', 'deleteItem', 'deleteMessage', 'pinItem', 'removeMoneroWall',
  'openMoneroWallComments',
  'rateMoneroWallPost',
  'upsertBio', 'upsertBounty', 'upsertComment', 'upsertDiscussion', 'upsertJob',
  'upsertLink', 'upsertPoll', 'upsertSubBranding',
  // post-window addendum (2026-10-04 spec): free, owner-only content edit of
  // the author's own item — no money path by construction.
  'updateItemAddendum',
  // turf repost (2026-09-24): adds a paid turf to one of the author's own
  // posts — same posting-fee money flow as the upsert* mutations above.
  'repostItem',
  // own-content draft CRUD (no money; publish flows through createItem)
  'upsertDraft', 'deleteDraft',
  // uploads (quota-capped, paid on publish)
  'getSignedPOST',
  // notifications / preferences
  'createMessage', 'onAirToggle', 'setWalkthrough', 'subscribeItem',
  'subscribeUserComments', 'subscribeUserPosts', 'toggleMute',
  'toggleMuteSub', 'toggleSubSubscription', 'updateCommentsViewAt'
])

describe('schema consistency (new mutations must be classified)', () => {
  test('every blocked name is a real Mutation field (a typo would silently disable its block)', () => {
    const schema = schemaMutationNames()
    for (const name of API_KEY_BLOCKED_MUTATIONS) {
      expect(schema.has(name)).toBe(true)
    }
  })

  test('every schema mutation is classified as blocked or reviewed-non-sensitive', () => {
    const unclassified = [...schemaMutationNames()]
      .filter(name => !API_KEY_BLOCKED_MUTATIONS.has(name) && !REVIEWED_NON_SENSITIVE.has(name))
    expect(unclassified).toEqual([])
  })

  test('the block list and the reviewed allow list are disjoint and schema-anchored', () => {
    const schema = schemaMutationNames()
    for (const name of REVIEWED_NON_SENSITIVE) {
      expect(API_KEY_BLOCKED_MUTATIONS.has(name)).toBe(false)
      expect(schema.has(name)).toBe(true)
    }
  })
})

describe('isApiKeyBlocked', () => {
  test('blocks every sensitive mutation for an API-key session', () => {
    for (const fieldName of SENSITIVE) {
      expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Mutation', fieldName })).toBe(true)
    }
  })

  test('allows queries and non-sensitive mutations for an API-key session', () => {
    expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Query', fieldName: 'me' })).toBe(false)
    expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Mutation', fieldName: 'upsertLink' })).toBe(false)
    expect(isApiKeyBlocked({ me: { apiKey: true }, parentTypeName: 'Mutation', fieldName: 'deleteItem' })).toBe(false)
  })

  test('does not block cookie sessions or anonymous callers', () => {
    expect(isApiKeyBlocked({ me: { id: 1 }, parentTypeName: 'Mutation', fieldName: 'generateApiKey' })).toBe(false)
    expect(isApiKeyBlocked({ me: null, parentTypeName: 'Mutation', fieldName: 'generateApiKey' })).toBe(false)
  })

  test('set contains the exact sensitive names (guards against typos)', () => {
    for (const name of SENSITIVE) expect(API_KEY_BLOCKED_MUTATIONS.has(name)).toBe(true)
  })
})

describe('apiKeyGuardPlugin', () => {
  function willResolveField ({ me, parentTypeName, fieldName }) {
    const execution = apiKeyGuardPlugin().requestDidStart().executionDidStart()
    return execution.willResolveField({
      contextValue: { me },
      info: { parentType: { name: parentTypeName }, fieldName }
    })
  }

  test('throws for an API-key session on a sensitive mutation', () => {
    expect(() => willResolveField({
      me: { apiKey: true },
      parentTypeName: 'Mutation',
      fieldName: 'generateApiKey'
    })).toThrow(GqlAuthorizationError)
  })

  test('allows cookie sessions, API-key queries, and API-key non-sensitive mutations', () => {
    expect(() => willResolveField({
      me: { id: 1 },
      parentTypeName: 'Mutation',
      fieldName: 'generateApiKey'
    })).not.toThrow()

    expect(() => willResolveField({
      me: { apiKey: true },
      parentTypeName: 'Query',
      fieldName: 'me'
    })).not.toThrow()

    expect(() => willResolveField({
      me: { apiKey: true },
      parentTypeName: 'Mutation',
      fieldName: 'upsertLink'
    })).not.toThrow()
  })
})
