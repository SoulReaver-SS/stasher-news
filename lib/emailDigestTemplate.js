import removeMd from 'remove-markdown'
import { indexableMoneroWallText } from '@/lib/monero-wall'

// Pure renderer for the weekly digest. No DB, no network: the worker and the
// preview script both call this with gathered sections. Email clients get a
// system font stack (webfonts are unreliable) and text-only links.

const EXCERPT_LEN = 140

function truncate (text, max) {
  const s = String(text ?? '').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function itemLabel (item) {
  if (item.title) return item.title
  const excerpt = truncate(removeMd(indexableMoneroWallText(item) ?? ''), EXCERPT_LEN)
  return excerpt || 'new activity'
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

export function renderDigest ({ name, sections, windowStart, windowEnd, unsubscribeUrl, siteUrl }) {
  const { replies = [], mentions = [], itemMentions = [], subscriptions = [], highlights = [], repliesTruncated = false, mentionsTruncated = false, subscriptionsTruncated = false } = sections

  // mentions and itemMentions are separate sources, but the same item can land
  // in both (a comment that @'s you and also links your post) — dedupe by id,
  // keeping the first occurrence (@mention wins, matching the notifications
  // page type priority).
  const mentionItems = []
  const mentionIds = new Set()
  for (const i of [...mentions, ...itemMentions]) {
    const id = String(i.id)
    if (mentionIds.has(id)) continue
    mentionIds.add(id)
    mentionItems.push(i)
  }

  // lines carry no bullet marker: the text version prefixes `- `, the html
  // version wraps each line in <li> (an in-line dash would double the bullet)
  const replyLines = replies.map(i => `${itemLabel(i)} — @${i.userName}: ${siteUrl}/items/${i.id}`)
  const mentionLines = mentionItems.map(i => `${itemLabel(i)} — @${i.userName}: ${siteUrl}/items/${i.id}`)
  const subscriptionLines = subscriptions.map(i => `${itemLabel(i)} — @${i.userName}${i.subNames?.[0] ? ` · ~${i.subNames[0]}` : ''}: ${siteUrl}/items/${i.id}`)
  const highlightLines = highlights.map(i => `${i.title} — ~${i.subNames?.[0] ?? 'uncategorized'} · @${i.userName}: ${siteUrl}/items/${i.id}`)

  const blocks = []
  if (replyLines.length) blocks.push(['replies', replyLines])
  if (mentionLines.length) blocks.push(['mentions', mentionLines])
  if (subscriptionLines.length) blocks.push(['from your subscriptions', subscriptionLines])
  if (highlightLines.length) blocks.push(['community highlights', highlightLines])

  const truncated = repliesTruncated || mentionsTruncated || subscriptionsTruncated
  const text = [
    `hey ${name}, here's what happened on stasher news`,
    '',
    ...blocks.flatMap(([title, lines]) => [`${title.toUpperCase()}:`, ...lines.map(line => `- ${line}`), '']),
    ...(truncated ? [`more in your notifications: ${siteUrl}/notifications`, ''] : []),
    "you're getting this because an email is linked to your stasher news account.",
    `turn it off: ${unsubscribeUrl}`,
    `manage in settings: ${siteUrl}/settings`
  ].join('\n')

  const htmlBlocks = blocks.map(([title, lines]) => `
    <h3 style="margin: 24px 0 8px; font-size: 17px; font-weight: 700;">${escapeHtml(title)}</h3>
    <ul style="margin: 0; padding-left: 20px;">${lines.map(line => `<li>${escapeHtml(line).replace(/https?:\/\/\S+/g, url => `<a href="${url}">${url}</a>`)}</li>`).join('')}</ul>`).join('')

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 16px;">
  <h2 style="margin: 0 0 4px; font-size: 18px;">your stasher news week</h2>
  <p style="margin: 0; color: #555;">hey ${escapeHtml(name)}, here's what happened while you were away.</p>
  ${htmlBlocks}
  ${truncated ? `<p style="margin: 24px 0 0;"><a href="${escapeHtml(`${siteUrl}/notifications`)}">more in your notifications</a></p>` : ''}
  <p style="margin-top: 32px; font-size: 12px; color: #888;">
    you're getting this because an email is linked to your stasher news account.
    <a href="${escapeHtml(unsubscribeUrl)}">turn it off</a> or
    <a href="${escapeHtml(`${siteUrl}/settings`)}">manage in settings</a>.
  </p>
</body></html>`

  const bits = []
  if (replies.length) bits.push(`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`)
  if (mentionLines.length) bits.push(`${mentionLines.length} ${mentionLines.length === 1 ? 'mention' : 'mentions'}`)
  if (subscriptions.length) bits.push(`${subscriptions.length} from subscriptions`)
  const subject = bits.length ? `your stasher news week: ${bits.join(' · ')}` : 'your stasher news week'

  return { subject, text, html }
}
