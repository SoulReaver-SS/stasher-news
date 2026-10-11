import { Prisma } from '@prisma/client'
import { resignImgproxyPath, verifyImgproxyPath } from '@/lib/imgproxy'
import { logInfo } from '@/lib/logger'

// value-shape driven: any string entry starting with '/' is a root-relative
// signed imgproxy path — covers every width set and any future variants
const pathEntries = (entry) => Object.entries(entry ?? {})
  .filter(([, v]) => typeof v === 'string' && v.startsWith('/'))

export const resignEntry = (entry) => {
  let changed = false
  const next = { ...entry }
  for (const [key, value] of pathEntries(entry)) {
    const resigned = resignImgproxyPath(value)
    if (resigned !== value) { next[key] = resigned; changed = true }
  }
  return changed ? next : entry
}

export const resignImgproxyUrls = (imgproxyUrls) => {
  let changed = false
  const next = {}
  for (const [url, entry] of Object.entries(imgproxyUrls ?? {})) {
    next[url] = resignEntry(entry)
    if (next[url] !== entry) changed = true
  }
  return changed ? next : imgproxyUrls
}

export const resignXPreview = (xPreview) => {
  if (!xPreview?.image) return xPreview
  const image = resignEntry(xPreview.image)
  return image === xPreview.image ? xPreview : { ...xPreview, image }
}

export const findSignatureMismatch = async (models, limit = 5) => {
  const items = await models.item.findMany({
    where: { OR: [{ imgproxyUrls: { not: Prisma.AnyNull } }, { xPreview: { not: Prisma.AnyNull } }] },
    orderBy: { id: 'desc' },
    take: 25,
    select: { imgproxyUrls: true, xPreview: true }
  })
  const paths = []
  for (const { imgproxyUrls, xPreview } of items) {
    for (const entry of Object.values(imgproxyUrls ?? {})) {
      for (const [, v] of pathEntries(entry)) paths.push(v)
    }
    for (const [, v] of pathEntries(xPreview?.image)) paths.push(v)
    if (paths.length >= limit) break
  }
  if (paths.length === 0) return false // fresh DB: nothing signed yet, clean no-op
  return paths.slice(0, limit).some(p => !verifyImgproxyPath(p))
}

// NOTE: this is a pure re-signature pass. Sources are deliberately NOT
// re-fetched (that's what makes it fast and safe to retry). Items whose
// source object is gone keep a valid signature over a dead target — a 404
// after re-sign means a lost source object, NOT a re-sign bug.
const BATCH_SIZE = 200
export async function imgproxyResign ({ models }) {
  let cursor = 0
  let scanned = 0
  let updated = 0
  while (true) {
    const items = await models.item.findMany({
      where: { OR: [{ imgproxyUrls: { not: Prisma.AnyNull } }, { xPreview: { not: Prisma.AnyNull } }] },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      select: { id: true, imgproxyUrls: true, xPreview: true }
    })
    if (items.length === 0) break
    for (const item of items) {
      scanned++
      const imgproxyUrls = resignImgproxyUrls(item.imgproxyUrls)
      const xPreview = resignXPreview(item.xPreview)
      if (imgproxyUrls !== item.imgproxyUrls || xPreview !== item.xPreview) {
        // compare-and-set on the preview the re-sign was computed from: a
        // concurrent edit may have cleared or replaced it, and a stale write
        // would restore a provenance claim the edit removed
        const { count } = await models.item.updateMany({
          where: {
            id: item.id,
            xPreview: { equals: item.xPreview === null ? Prisma.DbNull : item.xPreview }
          },
          data: { imgproxyUrls, xPreview }
        })
        if (count > 0) updated++
      }
    }
    cursor = items[items.length - 1].id
    if (items.length < BATCH_SIZE) break
  }
  logInfo({ scanned, updated }, 'imgproxyResign: re-sign pass complete')
}
