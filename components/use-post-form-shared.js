import { useMe } from './me'
import { SubSelectInitial } from './sub-select'
import useItemSubmit from './use-item-submit'
import { useApolloClient, useQuery } from '@apollo/client/react'
import { useRouter } from 'next/router'
import { MY_DRAFT, DELETE_DRAFT } from '@/fragments/draft'
import { recordDraftPublication, clearDraftPublication } from '@/lib/draft-publication-ledger'
import { getPayIn, isPostingFeeSubmit } from '@/lib/pay-in'

/**
 * Shared hook for post form initialization
 * Reduces duplication across BountyForm, DiscussionForm, LinkForm, PollForm
 *
 * @param {Object} options
 * @param {Object} options.item - Existing item being edited (optional)
 * @param {Array} options.subs - Array of sub objects
 * @param {Object} options.mutation - GraphQL mutation for upserting
 * @param {Function} options.schemaFn - Schema function for validation
 * @param {string} options.prefix - Storage key prefix for drafts (e.g., 'bounty', 'discussion')
 * @param {Object|Function} [options.extraInitialValues] - Extra initial values
 * specific to the form type, or a function ({ draft }) => values for
 * draft-aware forms. The function is re-evaluated on every render so a server
 * draft loaded via ?draft=<id> is complete before the Formik form mounts.
 * @param {boolean} [options.navigateOnSubmit] - Forwarded to useItemSubmit (default true)
 * @param {Function} [options.onSuccessfulSubmit] - Forwarded to useItemSubmit
 * @returns {Object} { initial, onSubmit, me, client, storageKeyPrefix, schema, draft, draftReady }
 */
export function usePostFormShared ({ item, subs, mutation, schemaFn, storageKeyPrefix: prefix, extraInitialValues, navigateOnSubmit, onSuccessfulSubmit }) {
  const router = useRouter()
  // if Web Share Target API was used
  const shareTitle = router.query.title
  const shareText = router.query.text ? decodeURI(router.query.text) : undefined
  const { me } = useMe()
  const client = useApolloClient()

  // server draft prefill (?draft=<id>): MY_DRAFT is in flight at mount, and
  // Formik initialValues are one-shot (no enableReinitialize here, deliberately:
  // it can reset mid-edit when `initial` recomputes with different values).
  // Forms render a skeleton until draftReady; repeat opens of the same draft
  // are instant (Apollo cache).
  const draftId = item ? undefined : router.query.draft
  const { data: draftData, loading: draftLoading, error: draftError } = useQuery(MY_DRAFT, {
    variables: { id: draftId },
    skip: !draftId
  })
  // a failed draft fetch must never wedge the form on the skeleton: fall
  // through to a clean create form
  const draft = draftError ? null : draftData?.draft
  const draftReady = !draftId || (!draftLoading && (draftData != null || draftError != null))

  const extras = typeof extraInitialValues === 'function' ? extraInitialValues({ draft }) : extraInitialValues

  const initial = {
    title: item?.title || draft?.title || shareTitle || '',
    text: item?.text || draft?.text || shareText || '',
    url: item?.url || draft?.url || undefined,
    ...SubSelectInitial({ item, subs }),
    // draft turf wins over URL/turf defaults (incl. the bounty 'bounties'
    // preselect). the formik field is `subNames` (SubSelectInitial), NOT subName
    ...(draft?.subName ? { subNames: [draft.subName] } : {}),
    ...extras
  }

  // kill the localStorage draft machinery while a server draft is open (or
  // when editing an item): Input's restore effect (components/form.js)
  // overwrites field values unconditionally on mount and would clobber the
  // prefill with a stale local draft; and local autosave must not fight the
  // explicit server save.
  const storageKeyPrefix = (item || draftId) ? undefined : prefix

  // publish cleanup: once the post is DURABLE, delete the draft (fire-and-
  // forget) and strip ?draft — that flips PostForm's remount key, so staying
  // on /post lands on a clean empty form.
  //
  // H2 (2026-09-26 review): a fee-gated submit only creates a PENDING_FEE
  // item behind a QR — onSuccessfulSubmit fires THEN, but the draft is the
  // only durable copy until the fee is observed (abandonFeeItems blanks the
  // unpaid item after 1 day, and the form is reset at QR time). Deleting the
  // draft at submit destroyed the user's work whenever the QR went unpaid, so
  // the deletion now runs at fee-paid via onPostingFeePaid. If the modal never
  // sees the payment (browser closed, paid later from the wallet), the draft
  // survives until the 90-day TTL sweep — content loss becomes a stale draft.
  // That leak is closed client-side by the publication ledger
  // (lib/draft-publication-ledger.js): fee-gated submits record
  // { draftId, itemId } and the drafts menu deletes the draft on a later load
  // once the item proves live.
  const deletePublishedDraft = () => {
    if (!draftId) return
    if (typeof window !== 'undefined') clearDraftPublication(window.localStorage, draftId)
    client.mutate({
      mutation: DELETE_DRAFT,
      variables: { id: draftId },
      update: cache => {
        // DELETE_DRAFT returns a scalar, so Apollo merges nothing: without
        // eviction the cache-first MY_DRAFTS list and MY_DRAFT singleton keep
        // serving the deleted draft (ghost menu row -> ghost prefill ->
        // 'draft not found' on the next save). Evict the entity AND filter
        // it out of the cached list (evicting alone can leave a dangling
        // reference in myDrafts).
        cache.evict({ id: `Draft:${draftId}` })
        cache.modify({
          fields: {
            myDrafts (existing = [], { readField }) {
              return existing.filter(ref => String(readField('id', ref)) !== String(draftId))
            }
          }
        })
        cache.gc()
      }
    }).catch(() => {})
    router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
  }

  const onSuccessWrapped = async (data, ...rest) => {
    if (draftId) {
      if (isPostingFeeSubmit(getPayIn(data))) {
        // fee-gated: only a PENDING_FEE item exists behind a QR — strip
        // ?draft (remount key / clean form) but leave the draft deletion to
        // onPostingFeePaid (H2: the draft is the only durable copy until the
        // fee is observed).
        //
        // The modal can vanish before the flip (its own copy invites closing
        // right after sending; tab closed; paid later from the wallet), and
        // then nothing deletes the draft. Record { draftId, itemId } so the
        // drafts menu's ledger sweep can finish the job on a later load
        // (2026-10-14 draft-post bug: jerry's drafts 252/256).
        const postId = getPayIn(data)?.payerPrivates?.result?.id
        if (postId != null && typeof window !== 'undefined') {
          recordDraftPublication(window.localStorage, { draftId, itemId: postId })
        }
        router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
      } else {
        // free publish: the post is durable the moment the mutation resolves,
        // and no fee modal ever shows to fire onPostingFeePaid — delete now
        // (regression, 2026-09-26: item 380119 / draft 139 orphaned the draft
        // and its upload pins because only the fee path deleted)
        deletePublishedDraft()
      }
    }
    return onSuccessfulSubmit?.(data, ...rest)
  }

  const onSubmit = useItemSubmit(mutation, {
    item,
    navigateOnSubmit,
    onSuccessfulSubmit: onSuccessWrapped,
    onPostingFeePaid: deletePublishedDraft
  })

  const schema = schemaFn?.({ client, me })

  return { initial, onSubmit, me, client, storageKeyPrefix, schema, draft, draftReady }
}
