/* eslint-env jest */
import { alert, __clearDedupe, DEDUPE_TTL_MS } from '@/lib/alert'

const URL = 'https://hooks.example.test/alert'

let fetchSpy
let savedUrl
let savedChannel
let savedChatId

beforeEach(() => {
  __clearDedupe()
  savedUrl = process.env.ALERT_WEBHOOK_URL
  savedChannel = process.env.ALERT_CHANNEL
  savedChatId = process.env.ALERT_TELEGRAM_CHAT_ID
  process.env.ALERT_WEBHOOK_URL = URL
  delete process.env.ALERT_CHANNEL
  delete process.env.ALERT_TELEGRAM_CHAT_ID
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 })
})

afterEach(() => {
  fetchSpy.mockRestore()
  if (savedUrl === undefined) delete process.env.ALERT_WEBHOOK_URL
  else process.env.ALERT_WEBHOOK_URL = savedUrl
  if (savedChannel === undefined) delete process.env.ALERT_CHANNEL
  else process.env.ALERT_CHANNEL = savedChannel
  if (savedChatId === undefined) delete process.env.ALERT_TELEGRAM_CHAT_ID
  else process.env.ALERT_TELEGRAM_CHAT_ID = savedChatId
})

function postedBody (n = 1) {
  const opts = fetchSpy.mock.calls[n - 1][1]
  return JSON.parse(opts.body)
}

describe('payload shape per channel', () => {
  test('slack posts { text } to ALERT_WEBHOOK_URL with JSON POST', async () => {
    process.env.ALERT_CHANNEL = 'slack'
    await alert('critical', 'reorg', 'depth regressed by 3')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, opts] = fetchSpy.mock.calls[0]
    expect(calledUrl).toBe(URL)
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(postedBody()).toEqual({ text: '[CRITICAL] reorg\ndepth regressed by 3' })
  })

  test('discord posts { content }', async () => {
    process.env.ALERT_CHANNEL = 'discord'
    await alert('warn', 'lws-down', 'lws health 503')
    expect(postedBody()).toEqual({ content: '[WARN] lws-down\nlws health 503' })
  })

  test('telegram posts { chat_id, text, parse_mode }', async () => {
    process.env.ALERT_CHANNEL = 'telegram'
    process.env.ALERT_TELEGRAM_CHAT_ID = '-100123'
    await alert('info', 'deploy', 'ok')
    expect(postedBody()).toEqual({
      chat_id: '-100123',
      text: '[INFO] *deploy*\nok',
      parse_mode: 'Markdown'
    })
  })

  test('email posts { subject, text, level }', async () => {
    process.env.ALERT_CHANNEL = 'email'
    await alert('critical', 'db-down', 'pg unreachable')
    expect(postedBody()).toEqual({
      subject: '[CRITICAL] db-down',
      text: 'pg unreachable',
      level: 'critical'
    })
  })

  test('defaults to slack when ALERT_CHANNEL is unset', async () => {
    await alert('info', 'x', 'y')
    expect(Object.keys(postedBody()).sort()).toEqual(['text'])
  })

  test('null body becomes empty string in payload', async () => {
    await alert('info', 'x', null)
    expect(postedBody()).toEqual({ text: '[INFO] x\n' })
  })
})

describe('dedupe', () => {
  test('collapses repeats sharing a dedupeKey within the TTL window', async () => {
    await alert('critical', 'reorg', 'd1', { dedupeKey: 'reorg' })
    await alert('critical', 'reorg', 'd2', { dedupeKey: 'reorg' })
    await alert('critical', 'reorg', 'd3', { dedupeKey: 'reorg' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('distinct dedupeKeys each post', async () => {
    await alert('warn', 'a', 'x', { dedupeKey: 'k1' })
    await alert('warn', 'b', 'y', { dedupeKey: 'k2' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('no dedupeKey never collapses', async () => {
    await alert('warn', 'a', 'x')
    await alert('warn', 'a', 'x')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('fires again after the TTL window elapses', async () => {
    jest.useFakeTimers()
    try {
      await alert('critical', 'reorg', 'first', { dedupeKey: 'reorg' })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(DEDUPE_TTL_MS + 1)
      await alert('critical', 'reorg', 'second', { dedupeKey: 'reorg' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('no-op when webhook unset', () => {
  test('does not throw and does not call fetch', () => {
    delete process.env.ALERT_WEBHOOK_URL
    expect(() => alert('critical', 'x', 'y')).not.toThrow()
    expect(alert('critical', 'x', 'y')).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('delivery outcome is observable (Finding 2)', () => {
  // worker/jobExpiryMonitor marks a job notified only when delivery succeeded,
  // so alert() must resolve true/false rather than undefined. Existing callers
  // ignore the return value, so nothing else changes.
  test('resolves true when the POST receives an OK response', async () => {
    await expect(alert('critical', 'x', 'y')).resolves.toBe(true)
  })

  test('resolves false on a non-OK status (503)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 })
    await expect(alert('critical', 'x', 'y')).resolves.toBe(false)
  })

  test('resolves false on a caught transport error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(alert('critical', 'x', 'y')).resolves.toBe(false)
  })

  test('returns false on every skip path (unset URL, invalid level, deduped)', async () => {
    delete process.env.ALERT_WEBHOOK_URL
    expect(alert('critical', 'x', 'y')).toBe(false)
    process.env.ALERT_WEBHOOK_URL = URL
    expect(alert('boom', 'x', 'y')).toBe(false)
    await expect(alert('critical', 'x', 'y', { dedupeKey: 'k' })).resolves.toBe(true)
    expect(alert('critical', 'x', 'y', { dedupeKey: 'k' })).toBe(false)
  })
})

describe('alert failure never throws', () => {
  test('network rejection is swallowed', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(alert('critical', 'x', 'y')).resolves.toBe(false)
  })

  test('non-ok HTTP response is swallowed', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(alert('critical', 'x', 'y')).resolves.toBe(false)
  })

  test('fetch throwing synchronously is swallowed', async () => {
    fetchSpy.mockImplementationOnce(() => { throw new Error('sync boom') })
    await expect(alert('critical', 'x', 'y')).resolves.toBe(false)
  })
})

describe('invalid level', () => {
  test('unknown level is rejected without posting', async () => {
    await alert('boom', 'x', 'y')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
