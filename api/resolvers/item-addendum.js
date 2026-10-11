// api/resolvers/item-addendum.js
// Post-window addenda (2026-10-04 spec): a free, owner-only save of the single
// informational edit below a locked original. Deliberately NOT the payIn
// engine: no PayIn, no fee, no quota, no upload paid-flag writes; the original
// text/url/title, their ItemUpload pins, and any deferred ITEM_UPDATE are
// untouched. Concurrency: an explicit row lock plus the author-side
// addendumRevision token — which is never reset (clears increment it too), so
// a stale tab cannot ABA-overwrite a cleared addendum.
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import { rateLimit } from '@/lib/rate-limit'
import { ADMIN_ITEMS, SN_ADMIN_IDS } from '@/lib/constants'
import { getItemEditMode, itemEditDeadline, normalizeAddendumText } from '@/lib/item-addendum'
import { isJob } from '@/lib/item'
import { lexicalHTMLGenerator } from '@/lib/lexical/server/html'
import { getItem, moneroWallStateFor } from './item'
import { uploadIdsFromText } from './upload'

// Same lookup the Item.payIn resolver does, duplicated locally (kept narrow on
// purpose: this module already names-imports from resolvers/item, and the
// save path needs a PAID-filtered variant anyway).
async function creationPayIn (models, itemId) {
  return models.payIn.findFirst({
    where: { itemPayIn: { itemId }, payInType: 'ITEM_CREATE', successorId: null },
    orderBy: { createdAt: 'desc' }
  })
}

// Inputs for the shared edit-mode helper. Item metadata rows (itemQueryWithMeta)
// already carry `payIn` and a `to_json(users.*)` user (bioId included), so the
// common case needs no extra query; only raw Prisma rows fall back.
async function editInputs (item, ctx) {
  const { me, models, userLoader } = ctx
  let payIn = item.payIn
  if (payIn === undefined) payIn = await creationPayIn(models, Number(item.id))
  let bioId = item.user?.bioId
  if (bioId === undefined && me) {
    bioId = userLoader
      ? (await userLoader.load(Number(me.id)))?.bioId
      : (await models.user.findUnique({ where: { id: Number(me.id) }, select: { bioId: true } }))?.bioId
  }
  return {
    payIn,
    myBio: bioId != null && Number(bioId) === Number(item.id),
    adminEdit: ADMIN_ITEMS.includes(Number(item.id)) && SN_ADMIN_IDS.includes(Number(me?.id))
  }
}

// The monerowall gates the addendum like the rest of the body: a locked (or
// contract-missing) view yields nothing, on every representation (raw text,
// time, HTML, lexical state) — 2026-09-26 H1 contract.
async function addendumVisible (item, ctx) {
  if (!item.addendumText || item.deletedAt) return false
  const view = await moneroWallStateFor(item, ctx)
  return !(view?.locked)
}

export default {
  Mutation: {
    updateItemAddendum: async (parent, { id, text: inputText, expectedRevision }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const itemId = Number(id)
      // PostgreSQL INTEGER bound, not just safe-integer: the ::INTEGER cast in
      // the lock query would otherwise raise a raw Postgres error
      if (!Number.isSafeInteger(itemId) || itemId <= 0 || itemId > 2_147_483_647) {
        throw new GqlInputError('bad item id')
      }
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new GqlInputError('bad expected revision')
      const rl = rateLimit({ key: `item-addendum:${me.id}`, limit: 30, windowMs: 60_000 })
      if (!rl.allowed) throw new GqlInputError('too many addendum saves, try again shortly')

      return await models.$transaction(async tx => {
        // serialize concurrent saves (two tabs, clear-then-recreate races)
        await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${itemId}::INTEGER FOR UPDATE`
        const old = await tx.item.findUnique({ where: { id: itemId } })
        if (!old || old.deletedAt || Number(old.userId) !== Number(me.id)) {
          throw new GqlInputError('item not found')
        }
        const payIn = await tx.payIn.findFirst({
          where: { itemPayIn: { itemId }, payInType: 'ITEM_CREATE', payInState: 'PAID' },
          orderBy: { createdAt: 'desc' }
        })
        const user = await tx.user.findUnique({ where: { id: Number(me.id) }, select: { bioId: true } })
        const mode = getItemEditMode({ ...old, payIn }, {
          meId: me.id,
          myBio: user?.bioId != null && Number(user.bioId) === old.id,
          adminEdit: ADMIN_ITEMS.includes(old.id) && SN_ADMIN_IDS.includes(Number(me.id))
        })
        if (mode !== 'ADDENDUM') {
          throw new GqlInputError('this item is not in addendum edit mode')
        }
        if (old.addendumRevision !== expectedRevision) {
          throw new GqlInputError('the addendum changed; reload before saving', 'E_ADDENDUM_CONFLICT')
        }
        const text = normalizeAddendumText(inputText)
        if ((old.addendumText ?? '') === text) {
          // normalized no-op: leave time and revision untouched
          return getItem(null, { id: itemId }, { models: tx, me })
        }

        // existence-only validation: reuse is allowed for foreign, large, and
        // fee-unsettled uploads — retention is the sweep's fee-aware job
        // (worker/deleteUnusedImages.js), never a save-time check
        const uploadIds = uploadIdsFromText(text)
        const uploads = uploadIds.length > 0
          ? await tx.upload.findMany({ where: { id: { in: uploadIds } }, select: { id: true } })
          : []
        if (uploads.length !== uploadIds.length) {
          throw new GqlInputError('a referenced Stasher upload is no longer available')
        }

        await tx.item.update({
          where: { id: itemId },
          data: {
            addendumText: text || null,
            addendumUpdatedAt: text ? new Date() : null,
            addendumRevision: { increment: 1 }
          }
        })
        // replace addendum-only pins; original ItemUpload rows are never touched
        await tx.itemAddendumUpload.deleteMany({ where: { itemId } })
        if (uploadIds.length > 0) {
          await tx.itemAddendumUpload.createMany({
            data: uploadIds.map(uploadId => ({ itemId, uploadId }))
          })
        }
        // refresh the whole current url map (original + addendum) — the same
        // job the paid edit path queues; rollback undoes pins and text alike
        await tx.$executeRaw`
          INSERT INTO pgboss.job (name, data, retrylimit, retrybackoff, startafter, keepuntil)
          VALUES ('imgproxy', jsonb_build_object('id', ${itemId}::INTEGER), 21, true,
                    now() + interval '5 seconds', now() + interval '1 day')`
        // return the META row, not the raw update row: the response feeds
        // Apollo's normalized cache directly, and a media-bearing addendum
        // must render with proxied imgproxyUrls/rel without a refetch
        return getItem(null, { id: itemId }, { models: tx, me })
      }, { timeout: 10000 })
    }
  },

  Item: {
    editMode: async (item, args, ctx) => {
      if (!ctx.me) return 'NONE'
      const { payIn, myBio, adminEdit } = await editInputs(item, ctx)
      return getItemEditMode(item, { meId: ctx.me.id, payIn, myBio, adminEdit })
    },
    editExpiresAt: async (item, args, ctx) => {
      if (!ctx.me) return null
      const { payIn, myBio, adminEdit } = await editInputs(item, ctx)
      // surface the deadline exactly where the author sees a countdown (timed
      // FULL) or holds the addendum editor; forever-edit exceptions and the
      // unpaid first-stage flow keep it null, as today
      const mode = getItemEditMode(item, { meId: ctx.me.id, payIn, myBio, adminEdit })
      if (mode === 'NONE') return null
      if (payIn?.payInState !== 'PAID' || myBio || adminEdit || isJob(item)) return null
      return itemEditDeadline(item)
    },
    addendumText: async (item, args, ctx) => (await addendumVisible(item, ctx)) ? item.addendumText : null,
    addendumUpdatedAt: async (item, args, ctx) => (await addendumVisible(item, ctx)) ? item.addendumUpdatedAt : null,
    // a counter, not content: stays visible under a lock so the author's form
    // can capture a fresh revision token after the wall unlocks
    addendumRevision: item => item.addendumRevision ?? 0,
    addendumLexicalState: async (item, args, ctx) => {
      if (!(await addendumVisible(item, ctx))) return null
      return await ctx.lexicalStateLoader.load({
        text: item.addendumText,
        context: {
          imgproxyUrls: item.imgproxyUrls,
          rel: item.rel,
          userId: item.userId,
          parentId: item.parentId,
          netInvestment: Number(item.netInvestment)
        }
      })
    },
    addendumHtml: async (item, args, ctx) => {
      if (!(await addendumVisible(item, ctx))) return null
      try {
        const lexicalState = await ctx.lexicalStateLoader.load({
          text: item.addendumText,
          context: {
            imgproxyUrls: item.imgproxyUrls,
            rel: item.rel,
            userId: item.userId,
            parentId: item.parentId,
            netInvestment: Number(item.netInvestment)
          }
        })
        if (!lexicalState) return null
        return lexicalHTMLGenerator(lexicalState, { readerXLinks: true })
      } catch (error) {
        console.error('error generating HTML from addendum Lexical State:', error)
        return null
      }
    }
  }
}
