import { gql } from 'graphql-tag'
import search from '@/api/search/index'
import removeMd from 'remove-markdown'
import { indexableMoneroWallText, moneroWallCommentsEnabled } from '@/lib/monero-wall'

const ITEM_SEARCH_FIELDS = gql`
  fragment ItemSearchFields on Item {
    id
    parentId
    createdAt
    updatedAt
    title
    text
    url
    userId
    subNames
    user {
      name
    }
    subs {
      name
    }
    root {
      subNames
      subs {
        name
      }
    }
    status
    company
    location
    remote
    upvotes
    lastCommentAt
    path
    ncomments
  }`

// Money columns are BigInt piconeros/credits in Prisma. They are unmapped in
// the OpenSearch index (dynamic: false) and no query reads them, so they are
// stripped from indexed docs — the client serializer uses JSON.stringify
// semantics, and a single BigInt aborts the ENTIRE bulk request
// (SerializationError: Do not know how to serialize a BigInt).
const UNINDEXED_MONEY_FIELDS = [
  'piconeros', 'credits', 'commentPiconeros', 'commentCredits',
  'boost', 'commentBoost', 'cost', 'commentCost'
]

// Safety net against schema drift: convert any BigInt that slips through to a
// JSON-safe value (Number when safe, else String).
function bigintSafe (value) {
  if (typeof value === 'bigint') {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value)
      : value.toString()
  }
  if (Array.isArray(value)) return value.map(bigintSafe)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintSafe(v)]))
  }
  return value
}

function indexableDoc (doc) {
  for (const field of UNINDEXED_MONEY_FIELDS) {
    delete doc[field]
  }
  return bigintSafe(doc)
}

// Wall-config columns for a thread root, used to keep walled-discussion
// comments out of the index (both indexing paths).
const ROOT_WALL_SELECT = {
  moneroWallEnabledAt: true,
  moneroWallRemovedAt: true,
  moneroWallCoversComments: true,
  moneroWallCommentsRemovedAt: true
}

export async function _indexItem (item, { models, updatedAt }) {
  console.log('indexing item', item.id)
  // HACK: modify the title for jobs so that company/location are searchable
  // and highlighted without further modification
  const itemcp = { ...item }
  if (item.company) {
    itemcp.title += ` \\ ${item.company}`
  }
  if (item.location || item.remote) {
    itemcp.title += ` \\ ${item.location || ''}${item.location && item.remote ? ' or ' : ''}${item.remote ? 'Remote' : ''}`
  }

  // Keep territory metadata in a flat array because ingest processing can
  // strip nested object fields (like sub.name) from _source.
  itemcp.subNames = item.subNames?.length > 0 ? item.subNames : (item.root?.subNames || [])

  const itemdb = await models.item.findUnique({
    where: { id: Number(item.id) },
    select: { weightedVotes: true, weightedDownVotes: true, ranktop: true, text: true, moneroWallEnabledAt: true, moneroWallRemovedAt: true, parentId: true, rootId: true }
  })

  // Monerowall-covered discussion (2026-10-14): a comment under a walled
  // discussion never enters the index (scrapers read search, not just
  // GraphQL). The lift mutations enqueue subtree indexItem jobs so opened
  // comments become searchable again.
  if (itemdb.parentId != null) {
    const root = await models.item.findUnique({ where: { id: Number(itemdb.rootId) }, select: ROOT_WALL_SELECT })
    // a missing root row is a data anomaly — skip, like the resolvers fail closed
    if (!root || moneroWallCommentsEnabled(root)) {
      console.log(`indexItem: skipping comment ${item.id} — discussion is monerowalled`)
      return
    }
  }

  itemcp.wvotes = itemdb.weightedVotes - itemdb.weightedDownVotes
  itemcp.ranktop = itemdb.ranktop

  // Body text from the DB, not the GraphQL-sourced `item.text` (which is
  // viewer-relative): walled posts index the teaser only, removed walls index
  // the full body.
  const indexText = indexableMoneroWallText({
    text: itemdb.text,
    moneroWallEnabledAt: itemdb.moneroWallEnabledAt,
    moneroWallRemovedAt: itemdb.moneroWallRemovedAt
  })
  if (indexText != null) {
    itemcp.text = removeMd(indexText)
  }

  // metadata: docType for filtering, textLength for scoring
  itemcp.docType = item.parentId ? 'comment' : 'post'
  itemcp.textLength = itemcp.text ? itemcp.text.length : 0

  const bookmarkedBy = await models.bookmark.findMany({
    where: { itemId: Number(item.id) },
    select: { userId: true, createdAt: true },
    orderBy: [
      {
        createdAt: 'desc'
      }
    ]
  })
  itemcp.bookmarkedBy = bookmarkedBy.map(bookmark => bookmark.userId)

  // use the latest of:
  // 1. an explicitly-supplied updatedAt value, used when a bookmark to this item was removed
  // 2. when the item itself was updated
  // 3. or when it was last bookmarked
  // to determine the latest version of the indexed version
  const latestUpdatedAt = Math.max(
    updatedAt ? new Date(updatedAt).getTime() : 0,
    new Date(item.updatedAt).getTime(),
    bookmarkedBy[0] ? new Date(bookmarkedBy[0].createdAt).getTime() : 0
  )

  try {
    const { body } = await search.getSource({
      id: item.id,
      index: process.env.OPENSEARCH_INDEX,
      _source_includes: ['contentHash', 'text_sparse', 'text_semantic', 'text_semantic_semantic_info']
    })
    if (body) Object.assign(itemcp, body)
  } catch (e) { /* doc doesn't exist yet */ }

  try {
    await search.index({
      id: item.id,
      index: process.env.OPENSEARCH_INDEX,
      version: new Date(latestUpdatedAt).getTime(),
      versionType: 'external_gte',
      body: indexableDoc(itemcp)
    })
  } catch (e) {
    if (e?.meta?.statusCode === 409) {
      console.log('version conflict ignoring', item.id)
      return
    }
    throw e
  }
}

// `data.updatedAt` is an explicit updatedAt value for the use case of a bookmark being removed
// this is consulted to generate the index version
export async function indexItem ({ data: { id, updatedAt }, apollo, models }) {
  // 1. grab item from database
  // could use apollo to avoid duping logic
  // when grabbing piconeros and user name, etc
  const { data: { item } } = await apollo.query({
    query: gql`
        ${ITEM_SEARCH_FIELDS}
        query Item {
          item(id: ${id}) {
            ...ItemSearchFields
          }
        }`
  })

  if (!item) {
    console.log('item not found', id)
    return
  }

  // 2. index it with external version based on updatedAt
  await _indexItem(item, { models, updatedAt })
}

// Send a batch of { id, doc } as update ops. If the client rejects the whole
// request (serializer error, connection, ...), retry each doc individually so
// one bad document cannot abort the rest of the batch; unindexable docs are
// logged and skipped.
async function bulkIndexDocs (osIndex, docs) {
  const action = id => ({ update: { _index: osIndex, _id: id } })
  try {
    return await search.bulk({
      body: docs.flatMap(({ id, doc }) => [action(id), { doc }]),
      pipeline: '_none'
    })
  } catch (e) {
    console.error(`indexAllItems: bulk request failed wholesale (${e.message}); retrying docs individually`)
    let skipped = 0
    for (const { id, doc } of docs) {
      try {
        const res = await search.bulk({ body: [action(id), { doc }], pipeline: '_none' })
        // updates 404 on docs not yet in the index — fall back to index
        if (res.body?.items?.[0]?.update?.status === 404) {
          await search.bulk({ body: [{ index: { _index: osIndex, _id: id } }, doc], pipeline: '_none' })
        }
      } catch (docErr) {
        skipped++
        console.error(`indexAllItems: skipping unindexable item ${id}:`, docErr.message)
      }
    }
    if (skipped > 0) {
      console.error(`indexAllItems: ${skipped}/${docs.length} docs skipped in fallback indexing`)
    }
    return { body: { errors: false, items: [] } }
  }
}

export async function indexAllItems ({ models, boss }) {
  const BATCH_SIZE = 1000
  let lastId = 0
  let total = 0

  const osIndex = process.env.OPENSEARCH_INDEX
  const exists = await search.indices.exists({ index: osIndex })
  if (!exists.body) {
    console.log(`indexAllItems: index '${osIndex}' does not exist yet, retrying in 30s`)
    await boss.send('indexAllItems', {}, { startAfter: 30 })
    return
  }

  const idxSettings = await search.indices.getSettings({ index: osIndex })
  // getSettings keys by concrete index name, not alias, so use the first value
  const pipeline = Object.values(idxSettings.body)[0]?.settings?.index?.default_pipeline
  if (!pipeline) {
    // The init script sets default_pipeline AFTER seed import completes,
    // so its absence means bootstrap is still in progress.
    console.log('indexAllItems: pipeline not configured yet (bootstrap in progress), retrying in 30s')
    await boss.send('indexAllItems', {}, { startAfter: 30 })
    return
  }

  const itemCount = await models.item.count()
  console.log(`indexAllItems: starting, ${itemCount} items to index`)

  await search.indices.putSettings({
    index: osIndex,
    body: { index: { refresh_interval: '-1' } }
  })

  try {
    while (true) {
      console.log(`indexAllItems: fetching batch (after id ${lastId})`)
      // PENDING_FEE items are invisible everywhere else (activeOrMine); the
      // incremental indexItem path filters them via the GraphQL resolver — the
      // bulk reindex must filter them here too or unpaid replies surface in search.
      const items = await models.item.findMany({
        where: { id: { gt: lastId }, feeStatus: { not: 'PENDING_FEE' } },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: {
          id: true,
          parentId: true,
          createdAt: true,
          updatedAt: true,
          title: true,
          text: true,
          url: true,
          userId: true,
          subNames: true,
          status: true,
          company: true,
          location: true,
          remote: true,
          upvotes: true,
          lastCommentAt: true,
          ncomments: true,
          rootId: true,
          weightedVotes: true,
          weightedDownVotes: true,
          ranktop: true,
          moneroWallEnabledAt: true,
          moneroWallRemovedAt: true,
          user: { select: { name: true } },
          root: {
            select: {
              subNames: true,
              ...ROOT_WALL_SELECT
            }
          },
          Bookmark: { select: { userId: true } }
        }
      })

      if (items.length === 0) break
      lastId = items[items.length - 1].id

      const docs = items
        // Monerowall-covered discussion: walled comments never enter the
        // index (matches the incremental _indexItem skip).
        .filter(item => !(item.parentId && moneroWallCommentsEnabled(item.root)))
        .map(item => {
          const doc = {
            ...item,
            wvotes: item.weightedVotes - item.weightedDownVotes,
            subNames: item.subNames?.length > 0
              ? item.subNames
              : (item.root?.subNames || []),
            bookmarkedBy: item.Bookmark.map(b => b.userId),
            docType: item.parentId ? 'comment' : 'post',
            textLength: 0 // set below after text processing
          }

          // job title hack: append company/location so they're searchable
          if (item.company) doc.title = `${doc.title} \\ ${item.company}`
          if (item.location || item.remote) {
            doc.title = `${doc.title} \\ ${item.location || ''}${item.location && item.remote ? ' or ' : ''}${item.remote ? 'Remote' : ''}`
          }
          if (item.text) doc.text = removeMd(indexableMoneroWallText(item))
          doc.textLength = doc.text ? doc.text.length : 0

          // clean up relation/raw fields not needed in the index
          delete doc.Bookmark
          delete doc.root

          return { id: item.id, doc: indexableDoc(doc) }
        })

      // Use update (NOT doc_as_upsert) to preserve seeded embedding fields.
      // doc_as_upsert triggers the default ingest pipeline even with pipeline=_none.
      console.log(`indexAllItems: sending ${items.length} items to opensearch`)
      const result = await bulkIndexDocs(osIndex, docs)

      if (result.body.errors) {
        // Collect 404s (new items not yet in the index) for fallback indexing
        const missingBody = []
        const otherErrors = []
        result.body.items.forEach((ri, idx) => {
          if (ri.update?.status === 404) {
            missingBody.push({ index: { _index: osIndex, _id: docs[idx].id } }, docs[idx].doc)
          } else if (ri.update?.error) {
            otherErrors.push(ri)
          }
        })

        if (missingBody.length > 0) {
          console.log(`indexAllItems: ${missingBody.length / 2} new items, indexing...`)
          const indexResult = await search.bulk({ body: missingBody, pipeline: '_none' })
          if (indexResult.body.errors) {
            const indexErrors = indexResult.body.items.filter(i => i.index?.error)
            if (indexErrors.length > 0) {
              console.error(`indexAllItems: ${indexErrors.length} index errors`, indexErrors.slice(0, 3))
            }
          }
        }

        if (otherErrors.length > 0) {
          console.error(`indexAllItems: ${otherErrors.length} bulk errors`, otherErrors.slice(0, 3))
        }
      }

      total += items.length
      const pct = Math.round((total / itemCount) * 100)
      console.log(`indexAllItems: ${total}/${itemCount} items indexed (${pct}%, last id: ${lastId})`)

      if (items.length < BATCH_SIZE) break
    }

    console.log(`indexAllItems complete: ${total} items indexed`)

    await search.indices.refresh({ index: osIndex })
    console.log(`indexAllItems: backfilling embeddings via pipeline '${pipeline}'`)

    const task = await search.updateByQuery({
      index: osIndex,
      pipeline,
      wait_for_completion: false,
      scroll_size: 200,
      body: {
        query: { match_all: {} },
        script: {
          source: "if (ctx._source.text_sparse != null && ctx._source.text_sparse.size() > 0) { ctx.op = 'noop'; }",
          lang: 'painless'
        }
      }
    })

    const taskId = task.body.task
    console.log(`indexAllItems: embedding backfill started (task: ${taskId})`)

    let pollMs = 1_000
    while (true) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
      pollMs = Math.min(pollMs * 2, 10_000)

      const status = await search.tasks.get({ task_id: taskId })
      const t = status.body.task.status
      const done = (t.updated || 0) + (t.noops || 0)
      const pct = t.total ? Math.round((done / t.total) * 100) : 0
      console.log(`indexAllItems: embeddings ${t.updated} updated, ${t.noops} skipped / ${t.total} (${pct}%)`)

      if (status.body.completed) {
        const failures = status.body.response?.failures || []
        if (failures.length > 0) {
          console.error(`indexAllItems: embedding backfill completed with ${failures.length} failures`,
            failures.slice(0, 5))
        } else {
          console.log(`indexAllItems: embedding backfill complete — ${t.updated} documents processed`)
        }
        break
      }
    }
  } finally {
    await search.indices.putSettings({
      index: osIndex,
      body: { index: { refresh_interval: null } }
    })
    await search.indices.refresh({ index: osIndex })
    console.log('indexAllItems: refresh interval restored and index refreshed')
  }
}
