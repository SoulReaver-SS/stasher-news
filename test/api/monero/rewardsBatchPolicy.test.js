/* eslint-env jest */
// Pure policy tests for bounded rewards payout batching (rewards payout size
// recovery, Task 1). No wallet, no DB: these helpers only order and split
// whole payout rows, and recognize the signer's exact transaction-size
// rejection without treating unrelated failures as retryable.
import {
  MAX_PAYOUTS_PER_TX, chunkPayouts, bisectPayouts, isTransactionSizeError,
  sizeRecoveryDecision
} from '@/api/monero/rewardsBatchPolicy'

const payout = (id, amount, distributionId = id) => ({
  id,
  piconeros: BigInt(amount),
  recipientAddress: `addr-${id}`,
  distributionId
})

test('18 equal payouts become 15 and 3 without losing membership', () => {
  const rows = Array.from({ length: 18 }, (_, i) => ({ id: i + 1, piconeros: 1n }))
  const before = [...rows]
  const chunks = chunkPayouts(rows)
  expect(MAX_PAYOUTS_PER_TX).toBe(15)
  expect(chunks.map(c => c.length)).toEqual([15, 3])
  expect(chunks.flat()).toEqual(rows)
  expect(rows).toEqual(before)
})

test.each([0, 1, 15, 16, 31])('preserves %i rows exactly once', count => {
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, piconeros: BigInt(i + 1) }))
  const chunks = chunkPayouts(rows)
  expect(chunks.every(c => c.length > 0 && c.length <= 15)).toBe(true)
  expect(new Set(chunks.flat().map(p => p.id)).size).toBe(count)
  expect(chunks.flat().map(p => p.id)).toEqual(rows.map(p => p.id).reverse())
})

test('orders largest amount first, ties by payout ID, without mutating the input', () => {
  const rows = [
    payout(3, 5),
    payout(1, 10),
    payout(2, 5),
    payout(4, 20)
  ]
  const before = rows.map(row => ({ ...row }))
  const chunks = chunkPayouts(rows)
  expect(chunks.flat().map(p => p.id)).toEqual([4, 1, 2, 3])
  expect(chunks.flat()).toHaveLength(rows.length)
  expect(rows).toEqual(before)
})

test('keeps every payout whole across a chunk boundary', () => {
  const rows = Array.from({ length: 16 }, (_, i) => payout(i + 1, i + 1))
  const chunks = chunkPayouts(rows)
  expect(chunks.map(c => c.length)).toEqual([15, 1])
  expect(chunks.flat().every(p => rows.includes(p))).toBe(true)
})

test('a recognized size rejection is not a generic hard error', () => {
  expect(isTransactionSizeError(new Error('Transaction would be too large.  Try create_txs()'))).toBe(true)
  expect(isTransactionSizeError(new Error('Transaction would be too large. Try create_txs()'))).toBe(true)
  expect(isTransactionSizeError(new Error('Transaction would be too large.\tTry create_txs()'))).toBe(true)
})

test('recognizes an upper-case string exception', () => {
  expect(isTransactionSizeError('TRANSACTION WOULD BE TOO LARGE.  Try create_txs()')).toBe(true)
  expect(isTransactionSizeError(' TRANSACTION WOULD BE TOO LARGE. TRY CREATE_TXS() ')).toBe(true)
})

test('does not classify unrelated or merely size-shaped messages as the signer rejection', () => {
  expect(isTransactionSizeError(new Error('tx not possible'))).toBe(false)
  expect(isTransactionSizeError(new Error('invalid recipient address'))).toBe(false)
  expect(isTransactionSizeError(new Error('Transaction would be too large'))).toBe(false)
  expect(isTransactionSizeError(new Error('transaction size limit exceeded'))).toBe(false)
})

test('non-errors, non-string messages, and unreadable message getters are not the signer rejection', () => {
  expect(isTransactionSizeError(null)).toBe(false)
  expect(isTransactionSizeError(undefined)).toBe(false)
  expect(isTransactionSizeError({ message: 42 })).toBe(false)
  expect(isTransactionSizeError({ get message () { throw new Error('unreadable') } })).toBe(false)
})

test('bisection cannot retry an unchanged group', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, piconeros: 1n }))
  const [left, right] = bisectPayouts(rows)
  expect([left.length, right.length]).toEqual([8, 7])
  expect([...left, ...right]).toEqual(rows)
  expect(() => bisectPayouts(rows.slice(0, 1))).toThrow(RangeError)
  expect(() => bisectPayouts([])).toThrow(RangeError)
})

test('bisection preserves order and handles the smallest bisectable group', () => {
  const rows = [payout(3, 30), payout(1, 10), payout(2, 20)]
  const before = rows.map(row => ({ ...row }))
  const [left, right] = bisectPayouts(rows)
  expect(left).toEqual([rows[0], rows[1]])
  expect(right).toEqual([rows[2]])
  expect(rows).toEqual(before)
})

test('an existing durable recovery prevents another cycle for that distribution/account', () => {
  const prior = [{ accountIndex: 1, distributionId: 7, state: 'RELAYED' }]
  expect(sizeRecoveryDecision(prior, { distributionId: 7, accountIndex: 1 })).toBe('exhausted')
  expect(sizeRecoveryDecision(prior, { distributionId: 8, accountIndex: 1 })).toBe('eligible')
  const reserved = [{ accountIndex: 1, distributionId: 6, state: 'PREPARED' }]
  expect(sizeRecoveryDecision(reserved, { distributionId: 7, accountIndex: 1 })).toBe('blocked')
})

test('a PREPARED reservation blocks any distribution and outranks an exhausted pair', () => {
  const rows = [
    { accountIndex: 1, distributionId: 7, state: 'RELAYED' },
    { accountIndex: 1, distributionId: 8, state: 'PREPARED' }
  ]
  expect(sizeRecoveryDecision(rows, { distributionId: 7, accountIndex: 1 })).toBe('blocked')
})

test('recovery decisions only consider the requested source account', () => {
  const rows = [
    { accountIndex: 2, distributionId: 7, state: 'RELAYED' },
    { accountIndex: 3, distributionId: 7, state: 'PREPARED' }
  ]
  expect(sizeRecoveryDecision(rows, { distributionId: 7, accountIndex: 4 })).toBe('eligible')
  expect(sizeRecoveryDecision(rows, { distributionId: 7, accountIndex: 3 })).toBe('blocked')
})
