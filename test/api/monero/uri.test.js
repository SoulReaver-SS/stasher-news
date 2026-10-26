/* eslint-env jest */
import { buildMoneroUri, piconerosToMillineroDecimal, piconerosToXmrDecimal } from '@/api/monero/uri'

const STAGENET_PRIMARY = '53H3SiSpNn6kiNubFw9Z5xq3QfHJqLiZyKQxhEVh7V9fFpa8jD9TmGv6g1REaX25Uo7sx2k1oYznxVqzD1Kb1vGfJyU6W4t' // 95-char base58 stagenet fixture

test('piconerosToXmrDecimal converts BigInt piconeros to a decimal XMR string', () => {
  expect(piconerosToXmrDecimal(0n)).toBe('0')
  expect(piconerosToXmrDecimal(1_000_000_000n)).toBe('0.001') // 0.001 XMR
  expect(piconerosToXmrDecimal(100_000_000n)).toBe('0.0001') // 0.0001 XMR (min tip)
  expect(piconerosToXmrDecimal(10_000_000_000n)).toBe('0.01') // free-post threshold
  expect(piconerosToXmrDecimal(1_000_000_000_000n)).toBe('1') // 1 XMR
  expect(piconerosToXmrDecimal(1_234_567_890_123n)).toBe('1.234567890123')
})

test('piconerosToXmrDecimal rejects non-BigInt input', () => {
  expect(() => piconerosToXmrDecimal(1000)).toThrow(/BigInt/)
  expect(() => piconerosToXmrDecimal('1000')).toThrow(/BigInt/)
})

test('piconerosToXmrDecimal maxDecimals truncates toward zero and trims trailing zeros', () => {
  expect(piconerosToXmrDecimal(1_234_567_890_123n, 3)).toBe('1.234')
  expect(piconerosToXmrDecimal(4_163_900_000n, 3)).toBe('0.004') // 0.004163 XMR -> rewards pool readout
  expect(piconerosToXmrDecimal(1_200_000_000_000n, 3)).toBe('1.2') // trailing zeros trimmed
  expect(piconerosToXmrDecimal(999_900_000_000n, 3)).toBe('0.999') // truncates, never rounds up
  expect(piconerosToXmrDecimal(-1_234_567_890_123n, 3)).toBe('-1.234')
  expect(piconerosToXmrDecimal(1_234_000_000_000n)).toBe('1.234') // default 12 unchanged
})

test('piconerosToMillineroDecimal converts BigInt piconeros to a decimal mXMR string', () => {
  expect(piconerosToMillineroDecimal(0n)).toBe('0')
  expect(piconerosToMillineroDecimal(1_000_000_000n)).toBe('1') // 1 mXMR
  expect(piconerosToMillineroDecimal(100_000_000n)).toBe('0.1') // 0.0001 XMR (min tip)
  expect(piconerosToMillineroDecimal(10_000_000_000n)).toBe('10') // 0.01 XMR
  expect(piconerosToMillineroDecimal(1_000_000_000_000n)).toBe('1000') // 1 XMR
  expect(piconerosToMillineroDecimal(1_234_567_890_123n)).toBe('1234.567890123')
})

test('piconerosToMillineroDecimal rejects non-BigInt input', () => {
  expect(() => piconerosToMillineroDecimal(1000)).toThrow(/BigInt/)
  expect(() => piconerosToMillineroDecimal('1000')).toThrow(/BigInt/)
})

test('piconerosToMillineroDecimal maxDecimals truncates toward zero and trims trailing zeros', () => {
  expect(piconerosToMillineroDecimal(1_234_567_890_123n, 3)).toBe('1234.567')
  expect(piconerosToMillineroDecimal(4_163_900_000n, 0)).toBe('4') // nav rewards readout
  expect(piconerosToMillineroDecimal(1_200_000_000_000n, 0)).toBe('1200')
  expect(piconerosToMillineroDecimal(999_900_000_000n, 3)).toBe('999.9')
  expect(piconerosToMillineroDecimal(-1_234_567_890_123n, 3)).toBe('-1234.567')
  expect(piconerosToMillineroDecimal(1_234_000_000_000n)).toBe('1234') // default 9 unchanged
})

test('buildMoneroUri emits a Cake-compatible single-destination URI with XMR decimal tx_amount', () => {
  const uri = buildMoneroUri(
    [{ address: STAGENET_PRIMARY, amount: 1_500_000_000n }],
    { description: 'tip on "hello world"' }
  )
  expect(uri).toBe(`monero:${STAGENET_PRIMARY}?tx_amount=0.0015&tx_description=tip+on+%22hello+world%22`)
  // Cake parses tx_amount as decimal XMR — 0.0015 XMR == 1.5e9 piconeros. Correct.
})

test('buildMoneroUri supports optional recipient_name and tx_payment_id', () => {
  const uri = buildMoneroUri(
    [{ address: STAGENET_PRIMARY, amount: 100_000_000n }],
    { recipientName: 'alice', paymentId: '4f695d197f2a3c54' }
  )
  expect(uri).toContain('tx_amount=0.0001')
  expect(uri).toContain('recipient_name=alice')
  expect(uri).toContain('tx_payment_id=4f695d197f2a3c54')
})

test('buildMoneroUri accepts 106-char integrated addresses (payment-ID tips)', () => {
  // real integrated address derived from a stagenet primary via makeIntegratedAddress
  // (106 chars, starts with 5 on stagenet). Tips use integrated addresses, not subaddresses.
  const integrated = '5DvToCSjUKkHuqNeRouyPcEpGz72iqs6FfudhNMB9SfNGi8G5yX6eKBDAwR6w9nayDRB7tS6x6hNWgzbtSvX7DqgdBUqSGEAz2fAXNJbsp'
  const uri = buildMoneroUri([{ address: integrated, amount: 100_000_000n }])
  expect(uri).toMatch(/^monero:5/)
})

test('buildMoneroUri rejects paymentId combined with an integrated (106-char) address', () => {
  // Feather's wallet2 parse_uri hard-fails this combination with
  // "Separate payment id given with an integrated address". The integrated
  // address already embeds the payment id, so the URI must never carry both.
  const integrated = '5DvToCSjUKkHuqNeRouyPcEpGz72iqs6FfudhNMB9SfNGi8G5yX6eKBDAwR6w9nayDRB7tS6x6hNWgzbtSvX7DqgdBUqSGEAz2fAXNJbsp'
  expect(() => buildMoneroUri(
    [{ address: integrated, amount: 100_000_000n }],
    { paymentId: '4f695d197f2a3c54' }
  )).toThrow(/integrated/)
})

test('buildMoneroUri rejects multi-destination (wallets cannot deep-link multi-output)', () => {
  expect(() => buildMoneroUri([
    { address: STAGENET_PRIMARY, amount: 1n },
    { address: STAGENET_PRIMARY, amount: 2n }
  ])).toThrow(/multi-destination/)
})

test('buildMoneroUri rejects non-BigInt amounts and malformed addresses', () => {
  expect(() => buildMoneroUri([{ address: STAGENET_PRIMARY, amount: 1000 }])).toThrow(/BigInt/)
  expect(() => buildMoneroUri([{ address: 'not-an-address', amount: 1n }])).toThrow(/address/)
  expect(() => buildMoneroUri([])).toThrow(/non-empty/)
})
