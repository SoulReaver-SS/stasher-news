// api/resolvers/draft.js
// Server-side drafts (2026-09-22 spec): owner-scoped CRUD with caps and
// derived media pins. No Item, no PayIn, no money path — publish flows through
// the existing createItem mutation.
import { MAX_POST_TEXT_LENGTH } from '@/lib/constants'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import { rateLimit } from '@/lib/rate-limit'
import { assertDraftCaps, syncDraftPins } from '@/lib/drafts'

const DRAFT_TYPES = ['DISCUSSION', 'LINK', 'BOUNTY', 'POLL']

// XMR string -> piconeros BigInt, mirroring the wall form fields' conversion;
// null/'' -> null (leg unset).
function xmrToPiconerosOrNull (s) {
  if (s == null || s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) throw new GqlInputError('monerowall amounts must be positive numbers')
  return BigInt(Math.round(n * 1e12))
}

function buildExtra ({ bountyPiconeros, pollOptions, pollExpiresAt, randPollOptions }) {
  const extra = {}
  if (bountyPiconeros != null && bountyPiconeros !== '') extra.bountyPiconeros = BigInt(bountyPiconeros).toString()
  if (pollOptions != null && pollOptions.length > 0) extra.pollOptions = pollOptions
  if (pollExpiresAt != null) extra.pollExpiresAt = new Date(pollExpiresAt).toISOString()
  if (randPollOptions != null) extra.randPollOptions = randPollOptions
  return Object.keys(extra).length > 0 ? extra : null
}

export default {
  Query: {
    myDrafts: async (parent, args, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      return models.draft.findMany({
        where: { userId: Number(me.id) },
        orderBy: { updatedAt: 'desc' }
      })
    },
    draft: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const d = await models.draft.findUnique({ where: { id: Number(id) } })
      if (!d || d.userId !== Number(me.id)) return null
      return d
    }
  },
  Mutation: {
    upsertDraft: async (parent, { input }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const rl = rateLimit({ key: `draft:${me.id}`, limit: 30, windowMs: 60_000 })
      if (!rl.allowed) throw new GqlInputError('too many draft saves, try again shortly')
      if (!DRAFT_TYPES.includes(input.type)) throw new GqlInputError('unknown draft type')
      if (input.text && input.text.length > MAX_POST_TEXT_LENGTH) {
        throw new GqlInputError(`draft text too long (max ${MAX_POST_TEXT_LENGTH})`)
      }

      const uploadIds = await assertDraftCaps({ models, meId: me.id, draftId: input.id ?? null, text: input.text ?? '' })
      const data = {
        type: input.type,
        title: input.title ?? null,
        text: input.text ?? null,
        url: input.url ?? null,
        subName: input.subName ?? null,
        extra: buildExtra(input),
        moneroWallPricePiconeros: xmrToPiconerosOrNull(input.moneroWallPriceXmr),
        moneroWallThresholdPiconeros: xmrToPiconerosOrNull(input.moneroWallThresholdXmr),
        moneroWallCoversComments: input.moneroWallCoversComments === true ? true : null
      }

      return models.$transaction(async tx => {
        let draft
        if (input.id != null) {
          const existing = await tx.draft.findUnique({ where: { id: Number(input.id) } })
          if (!existing || existing.userId !== Number(me.id)) throw new GqlInputError('draft not found')
          draft = await tx.draft.update({ where: { id: existing.id }, data })
        } else {
          draft = await tx.draft.create({ data: { ...data, userId: Number(me.id) } })
        }
        await syncDraftPins(tx, draft.id, uploadIds)
        return draft
      })
    },
    deleteDraft: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const existing = await models.draft.findUnique({ where: { id: Number(id) } })
      if (!existing || existing.userId !== Number(me.id)) return false
      await models.draft.delete({ where: { id: existing.id } }) // DraftUpload cascades
      return true
    }
  },
  Draft: {
    extra: (draft) => draft?.extra != null ? JSON.stringify(draft.extra) : null,
    // media meter (2026-09-22 cross-type rework): sum of the draft's pinned
    // upload sizes. ≤10 drafts per user, so per-draft aggregation is fine —
    // no server aggregate endpoint needed.
    pinnedMediaBytes: async (draft, args, { models }) => {
      const pins = await models.draftUpload.findMany({
        where: { draftId: draft.id },
        select: { upload: { select: { size: true } } }
      })
      return pins.reduce((acc, p) => acc + BigInt(p.upload?.size ?? 0), 0n)
    },
    // row meta "· N file(s)": number of uploads pinned by this draft
    pinnedMediaCount: async (draft, args, { models }) =>
      models.draftUpload.count({ where: { draftId: draft.id } })
  }
}
