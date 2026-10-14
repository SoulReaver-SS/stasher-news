// components/drafts-menu.js
// Server-side drafts: a split control (save draft | list) mounted top-right of
// each create form, plus a list-only instance on the /post type-picker page
// (no Form ancestor -> no formik -> no save half). The list is cross-type;
// opening a draft navigates to the draft's OWN form route on the ROOT /post
// path with ?draft=<id> (see the cross-type contract in the drafts plan).
// Explicit save only — no autosave in v1.
//
// Visual layer: styles/drafts-menu.module.css, mirroring the approved mockup
// (docs/superpowers/specs/2026-09-22-drafts-ui-mockups.html). The custom
// toggles render their own ▾ glyph + count because the app hides Bootstrap's
// .dropdown-toggle::after globally (styles/globals.scss).
import { forwardRef, useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { useFormikContext } from 'formik'
import Dropdown from 'react-bootstrap/Dropdown'
import { gql } from '@apollo/client'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { MY_DRAFTS, UPSERT_DRAFT, DELETE_DRAFT } from '@/fragments/draft'
import {
  readDraftPublications,
  resolveDraftPublications,
  writeDraftPublications
} from '@/lib/draft-publication-ledger'
import { xmrToPiconeros } from '@/lib/format'
import { DRAFT_MAX_COUNT, DRAFT_MEDIA_CAP_BYTES } from '@/lib/constants'
import { timeSince } from '@/lib/time'
import { useToast } from './toast'
import { useMe } from './me'
import styles from '@/styles/drafts-menu.module.css'

// Draft.type -> /post?type=<t>. Always lowercase query values; always root
// /post (never a turf-scoped path — defaultPostType would override the type).
const TYPE_QUERY = { DISCUSSION: 'discussion', LINK: 'link', BOUNTY: 'bounty', POLL: 'poll' }

// row icon tile glyphs, per the mockup
const TYPE_ICON = { DISCUSSION: '✎', LINK: '🔗', BOUNTY: '◎', POLL: '▤' }

const MB = 1024 * 1024

// ledger sweep lookup: is a recorded fee-gated publication's item live yet?
// (lib/draft-publication-ledger.js)
const DRAFT_PUBLICATION_ITEM_STATUS = gql`
  query DraftPublicationItemStatus($id: ID!) {
    item(id: $id) { id feeStatus }
  }
`

// custom dropdown toggles (module scope: stable identity, ref forwarded)
const CaretToggle = forwardRef(function CaretToggle ({ children, onClick, ...props }, ref) {
  return (
    <button
      ref={ref}
      type='button'
      {...props}
      className={styles.caret}
      onClick={onClick}
    >
      <span className={styles.caretGlyph} aria-hidden='true'>▾</span>
      <span className={styles.count}>{children}</span>
    </button>
  )
})

const PickerToggle = forwardRef(function PickerToggle ({ children, onClick, ...props }, ref) {
  return (
    <button
      ref={ref}
      type='button'
      {...props}
      className={styles.pickerToggle}
      onClick={onClick}
    >
      drafts
      <span className={styles.caretGlyph} aria-hidden='true'>▾</span>
      <span className={styles.count}>{children}</span>
    </button>
  )
})

export default function DraftsMenu ({ type }) {
  const router = useRouter()
  const toaster = useToast()
  const { me } = useMe()
  const formik = useFormikContext() // undefined on the picker page
  const client = useApolloClient()
  const { data, refetch } = useQuery(MY_DRAFTS, { skip: !me })
  const [upsertDraft] = useMutation(UPSERT_DRAFT)
  const [deleteDraft] = useMutation(DELETE_DRAFT)

  const drafts = data?.myDrafts ?? [] // cross-type: NO per-type filter
  const loadedDraftId = router.query.draft

  // publication-ledger sweep (lib/draft-publication-ledger.js): a fee-gated
  // publish deletes its draft only when the posting-fee modal is still open
  // when the fee flips — if it closed early, finish the job here on a later
  // load. Runs once per mount, after MY_DRAFTS resolves; entries whose item
  // is still pending stay recorded for the next visit.
  const sweptRef = useRef(false)
  useEffect(() => {
    if (!me || !data || sweptRef.current || typeof window === 'undefined') return
    sweptRef.current = true
    const sweep = async () => {
      const entries = readDraftPublications(window.localStorage)
      if (entries.length === 0) return
      const draftIds = new Set(drafts.map(d => String(d.id)))
      const itemStatusById = {}
      await Promise.all(entries
        .filter(e => draftIds.has(String(e.draftId)))
        .map(async e => {
          try {
            const { data: itemData } = await client.query({
              query: DRAFT_PUBLICATION_ITEM_STATUS,
              variables: { id: String(e.itemId) },
              fetchPolicy: 'network-only' // a cached feeStatus defeats the sweep
            })
            // item null (author-deleted or abandoned) keeps the draft
            itemStatusById[String(e.itemId)] = itemData?.item?.feeStatus ?? null
          } catch {
            // query failed: unknown outcome — retry on the next load
            itemStatusById[String(e.itemId)] = undefined
          }
        }))
      const { deleteDraftIds, remainingEntries } = resolveDraftPublications(entries, { draftIds, itemStatusById })
      if (deleteDraftIds.length > 0) {
        const outcomes = await Promise.allSettled(deleteDraftIds.map(id => deleteDraft({ variables: { id } })))
        // a delete that failed (or was never attempted) keeps its entry so the
        // next sweep retries — persisting before the mutations are known would
        // silently re-open the original bug for that draft
        const retryEntries = deleteDraftIds
          .filter((id, i) => outcomes[i].status === 'rejected')
          .map(id => entries.find(e => String(e.draftId) === String(id)))
          .filter(Boolean)
        writeDraftPublications(window.localStorage, [...remainingEntries, ...retryEntries])
        // the sweep deleting the draft that's currently open leaves a stale
        // editing session behind — reset it to a clean form (same as remove)
        if (loadedDraftId && deleteDraftIds.some(id => String(id) === String(loadedDraftId))) {
          router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
        }
        await refetch()
      } else {
        writeDraftPublications(window.localStorage, remainingEntries)
      }
    }
    sweep().catch(() => {})
  }, [me, data, drafts, client, deleteDraft, refetch, router, loadedDraftId])

  const save = async () => {
    if (!formik) return // picker-page instance: list-only, nothing to save
    const v = formik.values
    try {
      // built inside the try: xmrToPiconeros throws on an invalid/empty
      // bounty amount, and that must surface as a toast, not reject silently
      const input = {
        id: loadedDraftId,
        type,
        title: v.title || null,
        text: v.text || null,
        url: v.url || null,
        subName: v.subNames?.[0] ?? null,
        // per-form fields are simply absent in the other forms -> null
        bountyPiconeros: v.amount != null ? String(xmrToPiconeros(v.amount)) : null,
        pollOptions: v.options ?? null,
        pollExpiresAt: v.pollExpiresAt ?? null,
        randPollOptions: v.randPollOptions ?? null,
        // wall display fields hold NUMBERS (the inputs are type="number") —
        // DraftInput declares String, so coerce when present; explicit
        // empty/absent check (not ||) so a numeric 0 behaves predictably
        moneroWallPriceXmr: v.moneroWallEnabled && v.moneroWallPriceXmr != null && v.moneroWallPriceXmr !== '' ? String(v.moneroWallPriceXmr) : null,
        moneroWallThresholdXmr: v.moneroWallEnabled && v.moneroWallThresholdXmr != null && v.moneroWallThresholdXmr !== '' ? String(v.moneroWallThresholdXmr) : null,
        moneroWallCoversComments: v.moneroWallEnabled ? v.moneroWallCoversComments === true : null
      }
      const { data: saveData } = await upsertDraft({ variables: { input } })
      toaster.success('draft saved')
      await refetch()
      // establish the editing session on the FIRST save: without this, every
      // save from a fresh form mints a duplicate draft (10-draft cap lockout)
      // and usePostFormShared's publish cleanup (keyed on ?draft) never fires.
      // The replace remounts the form (post.js keys FormType on the draft id)
      // and prefills from the just-saved draft — values identical to the save.
      if (!loadedDraftId && saveData?.upsertDraft?.id != null) {
        router.replace({ query: { ...router.query, draft: String(saveData.upsertDraft.id) } }, undefined, { shallow: true })
      }
    } catch (err) {
      toaster.danger(err?.message ?? 'failed to save draft')
    }
  }

  // cross-type navigation: the draft's own type, root path, draft id in query.
  // the ?draft param + PostForm's remount key make the target form mount
  // fresh and prefill via usePostFormShared.
  const openDraft = (d) => {
    router.push({ pathname: '/post', query: { type: TYPE_QUERY[d.type], draft: d.id } })
  }

  const remove = async (e, d) => {
    e.stopPropagation()
    await deleteDraft({ variables: { id: d.id } }).catch(() => {})
    await refetch()
    // deleting the draft that's currently open leaves a stale editing
    // session behind — reset it to a clean form
    if (loadedDraftId && String(loadedDraftId) === String(d.id)) {
      router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
    }
  }

  // leave the editing session without publishing: delete + back to a clean form
  const discard = async () => {
    await deleteDraft({ variables: { id: loadedDraftId } }).catch(() => {})
    await refetch()
    router.replace({ query: { ...router.query, draft: undefined } }, undefined, { shallow: true })
  }

  const pinnedBytes = drafts.reduce((acc, d) => acc + BigInt(d.pinnedMediaBytes ?? 0), 0n)
  const showFooter = drafts.length > 0 // meter hidden entirely at 0 drafts (approved)
  const atCap = drafts.length >= DRAFT_MAX_COUNT
  const loadedDraft = loadedDraftId ? drafts.find(d => String(d.id) === String(loadedDraftId)) : undefined
  const capMb = Math.round(Number(DRAFT_MEDIA_CAP_BYTES) / MB)
  const meterPct = Math.min(100, (Number(pinnedBytes) / Number(DRAFT_MEDIA_CAP_BYTES)) * 100)

  // drafts are a per-user feature: no menu (and no MY_DRAFTS traffic) signed out
  if (!me) return null

  const list = (
    <>
      <div className={styles.header}>
        <span>your drafts</span>
        <span className={`${styles.headerCount} ${atCap ? styles.headerCountFull : ''}`}>
          {drafts.length} / {DRAFT_MAX_COUNT}
        </span>
      </div>
      {atCap && (
        <div className={styles.warn}>
          <span aria-hidden='true'>⚠</span>
          <span>draft limit reached ({DRAFT_MAX_COUNT}) — delete one first.</span>
        </div>
      )}
      {drafts.length > 0 && (
        <div className={styles.list}>
          {drafts.map(d => (
            <div
              key={d.id}
              className={styles.row}
              role='button'
              tabIndex={0}
              onClick={() => openDraft(d)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openDraft(d)
                }
              }}
            >
              <span className={styles.ico} aria-hidden='true'>{TYPE_ICON[d.type] ?? TYPE_ICON.DISCUSSION}</span>
              <span className={styles.mid}>
                <span className={styles.title}>{d.title || d.text?.slice(0, 60) || '(untitled draft)'}</span>
                <span className={styles.meta}>
                  <span className={styles.chip}>{d.type.toLowerCase()}</span>
                  saved {timeSince(new Date(d.updatedAt))} ago
                  {d.pinnedMediaCount > 0 ? ` · ${d.pinnedMediaCount} file${d.pinnedMediaCount === 1 ? '' : 's'}` : ''}
                </span>
              </span>
              <button
                type='button'
                className={styles.x}
                title='delete draft'
                aria-label='delete draft'
                onClick={e => remove(e, d)}
              >✕
              </button>
            </div>
          ))}
        </div>
      )}
      {drafts.length === 0 && (
        <div className={styles.empty}>no drafts yet — save this one to pick it up on any device.</div>
      )}
      {showFooter && (
        <div className={styles.footer}>
          <div className={styles.footerRow}>
            <span>saved media</span>
            <span className={styles.footerValue}>{(Number(pinnedBytes) / MB).toFixed(1)} / {capMb} MB</span>
          </div>
          <div className={styles.meter}><i style={{ width: `${meterPct}%` }} /></div>
          <div className={styles.footerNote}>auto-deletes after 90d of inactivity</div>
        </div>
      )}
    </>
  )

  if (!formik) {
    // picker page: a plain dropdown with only the list (no formik -> no save half)
    return (
      <div className={styles.root}>
        <Dropdown align='end'>
          <Dropdown.Toggle
            as={PickerToggle}
            aria-label={`open drafts (${drafts.length} of ${DRAFT_MAX_COUNT})`}
          >{drafts.length}
          </Dropdown.Toggle>
          <Dropdown.Menu className={styles.menu}>{list}</Dropdown.Menu>
        </Dropdown>
      </div>
    )
  }

  return (
    <div className={`${styles.root} ${loadedDraftId ? styles.fullWidth : ''}`}>
      {loadedDraftId && (
        <div className={styles.banner} role='status'>
          <span className={styles.dot} aria-hidden='true' />
          <span className={styles.bannerText}>
            editing draft{loadedDraft ? ` · saved ${timeSince(new Date(loadedDraft.updatedAt))} ago` : ''}
          </span>
          <button type='button' className={styles.discard} onClick={discard}>discard draft</button>
        </div>
      )}
      <div className={styles.rowEnd}>
        <div className={styles.split}>
          <button type='button' className={styles.save} onClick={save}>
            {loadedDraftId ? 'update draft' : 'save draft'}
          </button>
          <Dropdown align='end'>
            <Dropdown.Toggle
              as={CaretToggle}
              aria-label={`open drafts (${drafts.length} of ${DRAFT_MAX_COUNT})`}
            >{drafts.length}
            </Dropdown.Toggle>
            <Dropdown.Menu className={styles.menu}>{list}</Dropdown.Menu>
          </Dropdown>
        </div>
      </div>
    </div>
  )
}
