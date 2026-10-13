/* eslint-env jest */
import { snFetch } from '@/lib/fetch'
import { parseHandleFromUrl, parseOembedHtml, unshortenTco, fetchXPreview } from '@/lib/x-preview'

jest.mock(`${process.cwd()}/lib/fetch`, () => ({ snFetch: jest.fn() }))

const OEMBED_HTML = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">ZEC is a joke <a href="https://t.co/BoumSiIqkt">https://t.co/BoumSiIqkt</a> <a href="https://t.co/qohc4l9OOs">pic.twitter.com/qohc4l9OOs</a></p>&mdash; ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ (@DontTraceMeBruh) <a href="https://x.com/DontTraceMeBruh/status/2092467849000350095?ref_src=twsrc%5Etfw">August 26, 2026</a></blockquote>'

const OEMBED_JSON = {
  author_name: 'ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ',
  author_url: 'https://x.com/DontTraceMeBruh',
  html: OEMBED_HTML
}

const PAGE_HTML = '<html><head><meta property="og:image" content="https://pbs.twimg.com/media/HQnvtiKXgAAYVu1.jpg"></head><body></body></html>'

// X puts the author's profile picture (or banner) in og:image when a post has
// no media; it is never the post's media, so it must be dropped.
const AVATAR_HTML = '<html><head><meta property="og:image" content="https://pbs.twimg.com/profile_images/1977811636854403072/eZ2yvJA2_400x400.jpg"></head><body></body></html>'

const BANNER_HTML = '<html><head><meta property="og:image" content="https://pbs.twimg.com/profile_banners/1977811636854403072/1679034816/1500x500"></head><body></body></html>'

// video thumbnails live outside /media/, so only avatars/banners are rejected
const VIDEO_THUMB_HTML = '<html><head><meta property="og:image" content="https://ton.twimg.com/amplify_video_thumb/2093358461589356963/img/ZYxNnVhBxH.jpg"></head><body></body></html>'

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body, headers: { get: () => null } })
const redirect = (location) => ({ ok: true, status: 301, headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) } })

describe('parseHandleFromUrl', () => {
  it('extracts the handle from an x.com status URL', () => {
    expect(parseHandleFromUrl('https://x.com/DontTraceMeBruh/status/2092467849000350095')).toBe('DontTraceMeBruh')
  })

  it('extracts the handle from a twitter.com status URL', () => {
    expect(parseHandleFromUrl('https://twitter.com/satoshi/status/123')).toBe('satoshi')
  })

  it('returns null for a non-status URL', () => {
    expect(parseHandleFromUrl('https://x.com/home')).toBeNull()
  })
})

describe('parseOembedHtml', () => {
  it('extracts text, date and t.co hrefs from the blockquote', () => {
    const parsed = parseOembedHtml(OEMBED_HTML)
    expect(parsed.text).toContain('ZEC is a joke')
    expect(parsed.date).toBe('August 26, 2026')
    expect(parsed.tcoHrefs).toEqual(['https://t.co/BoumSiIqkt', 'https://t.co/qohc4l9OOs'])
  })

  it('keeps <br> line breaks as newlines', () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">one<br><br>two</p>&mdash; A (@a) <a href="https://x.com/a/status/1">May 1, 2026</a></blockquote>'
    expect(parseOembedHtml(html).text).toBe('one\n\ntwo')
  })

  it('returns null when there is no blockquote', () => {
    expect(parseOembedHtml('<html></html>')).toBeNull()
  })
})

describe('unshortenTco', () => {
  it('resolves a t.co redirect to the real URL', async () => {
    snFetch.mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343'))
    expect(await unshortenTco('https://t.co/BoumSiIqkt')).toBe('https://x.com/XBTXMR/status/2092396519026561343')
  })

  it('returns the href unchanged when there is no redirect', async () => {
    snFetch.mockResolvedValueOnce(ok(''))
    expect(await unshortenTco('https://t.co/BoumSiIqkt')).toBe('https://t.co/BoumSiIqkt')
  })

  it('returns null when the fetch throws', async () => {
    snFetch.mockRejectedValueOnce(new Error('timeout'))
    expect(await unshortenTco('https://t.co/BoumSiIqkt')).toBeNull()
  })
})

describe('fetchXPreview', () => {
  beforeEach(() => snFetch.mockReset())

  it('returns null for a non-twitter URL without fetching', async () => {
    expect(await fetchXPreview('https://example.com/article')).toBeNull()
    expect(snFetch).not.toHaveBeenCalled()
  })

  it('builds a preview from oEmbed + og:image, replacing t.co tokens', async () => {
    // NOTE: call order in fetchXPreview is oembed → t.co unshorten(s) → og:image
    // scrape (fetchOgImage runs LAST), so the mocks must be ordered accordingly.
    snFetch
      .mockResolvedValueOnce(ok(OEMBED_JSON)) // oembed
      .mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343')) // t.co 1
      .mockResolvedValueOnce(redirect('https://x.com/DontTraceMeBruh/status/2092467849000350095')) // t.co 2 (self media)
      .mockResolvedValueOnce(ok(PAGE_HTML)) // page scrape for og:image
    const preview = await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.authorName).toBe('ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ')
    expect(preview.handle).toBe('DontTraceMeBruh')
    expect(preview.date).toBe('August 26, 2026')
    expect(preview.statusUrl).toBe('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.imageUrl).toBe('https://pbs.twimg.com/media/HQnvtiKXgAAYVu1.jpg')
    // t.co token replaced by resolved destination; self-referential pic.twitter token dropped
    expect(preview.text).toContain('x.com/XBTXMR/status/2092396519026561343')
    expect(preview.text).not.toContain('t.co/')
    expect(preview.text).not.toContain('pic.twitter.com')
  })

  it('keeps <br> line breaks and collapses only horizontal whitespace', async () => {
    const oembed = {
      ...OEMBED_JSON,
      html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">a  b<br><br>c</p>&mdash; ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ (@DontTraceMeBruh) <a href="https://x.com/DontTraceMeBruh/status/2092467849000350095?ref_src=twsrc%5Etfw">August 26, 2026</a></blockquote>'
    }
    snFetch
      .mockResolvedValueOnce(ok(oembed)) // oembed
      .mockResolvedValueOnce(ok(PAGE_HTML)) // page scrape for og:image
    const preview = await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.text).toBe('a b\n\nc')
  })

  it('scrapes og:image with a body size cap above the 256KB default (large x.com pages)', async () => {
    snFetch
      .mockResolvedValueOnce(ok(OEMBED_JSON)) // oembed
      .mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343')) // t.co 1
      .mockResolvedValueOnce(redirect('https://x.com/DontTraceMeBruh/status/2092467849000350095')) // t.co 2
      .mockResolvedValueOnce(ok(PAGE_HTML)) // page scrape for og:image
    await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    const ogImageCall = snFetch.mock.calls[3]
    expect(ogImageCall[0]).toBe('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(ogImageCall[1].size).toBeGreaterThan(256 * 1024)
  })

  it('returns null when oEmbed fails (deleted/protected tweet)', async () => {
    snFetch.mockResolvedValueOnce({ ok: false, status: 404 })
    expect(await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')).toBeNull()
  })

  it('returns a preview without imageUrl when the page scrape fails', async () => {
    snFetch
      .mockResolvedValueOnce(ok(OEMBED_JSON)) // oembed
      .mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343')) // t.co 1
      .mockResolvedValueOnce(redirect('https://x.com/DontTraceMeBruh/status/2092467849000350095')) // t.co 2 (self media)
      .mockRejectedValueOnce(new Error('timeout')) // page scrape fails
    const preview = await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.authorName).toBe('ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ')
    expect(preview.imageUrl).toBeUndefined()
  })

  it('drops og:image when it is the author profile picture (media-less tweet)', async () => {
    snFetch
      .mockResolvedValueOnce(ok(OEMBED_JSON)) // oembed
      .mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343')) // t.co 1
      .mockResolvedValueOnce(redirect('https://x.com/DontTraceMeBruh/status/2092467849000350095')) // t.co 2 (self media)
      .mockResolvedValueOnce(ok(AVATAR_HTML)) // page scrape for og:image
    const preview = await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.authorName).toBe('ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ')
    expect(preview.imageUrl).toBeUndefined()
  })

  it('drops og:image when it is the author profile banner', async () => {
    snFetch
      .mockResolvedValueOnce(ok(OEMBED_JSON)) // oembed
      .mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343')) // t.co 1
      .mockResolvedValueOnce(redirect('https://x.com/DontTraceMeBruh/status/2092467849000350095')) // t.co 2 (self media)
      .mockResolvedValueOnce(ok(BANNER_HTML)) // page scrape for og:image
    const preview = await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.imageUrl).toBeUndefined()
  })

  it('keeps og:image when it is a video thumbnail outside /media/', async () => {
    snFetch
      .mockResolvedValueOnce(ok(OEMBED_JSON)) // oembed
      .mockResolvedValueOnce(redirect('https://x.com/XBTXMR/status/2092396519026561343')) // t.co 1
      .mockResolvedValueOnce(redirect('https://x.com/DontTraceMeBruh/status/2092467849000350095')) // t.co 2 (self media)
      .mockResolvedValueOnce(ok(VIDEO_THUMB_HTML)) // page scrape for og:image
    const preview = await fetchXPreview('https://x.com/DontTraceMeBruh/status/2092467849000350095')
    expect(preview.imageUrl).toBe('https://ton.twimg.com/amplify_video_thumb/2093358461589356963/img/ZYxNnVhBxH.jpg')
  })
})
