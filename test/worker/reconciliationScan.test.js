/* eslint-env jest */
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { createReconciliationCheckpoint, scanRawPaymentIds, prioritizeRecentTransactions } from '@/worker/reconciliationScan'
import { paymentIdCandidates } from '@/api/monero/pidDecrypt'

test('a checkpoint yields to the event loop only after its CPU slice', async () => {
  let clock = 0
  const checkpoint = createReconciliationCheckpoint({ now: () => clock })
  expect(checkpoint()).toBeNull()
  clock = 10
  let heartbeat = false
  setImmediate(() => { heartbeat = true })
  await checkpoint()
  expect(heartbeat).toBe(true)
  expect(checkpoint()).toBeNull()
})

test('raw PID scanning services I/O callbacks before completing a warm scan', async () => {
  let clock = 0
  const checkpoint = createReconciliationCheckpoint({ now: () => clock++, sliceMs: 1, yieldLoop })
  const raws = Array.from({ length: 100 }, (_, i) => ({ hash: String(i), extra: Buffer.alloc(0) }))
  let heartbeat = false
  setImmediate(() => { heartbeat = true })
  let seen = 0
  for await (const { raw, pids } of scanRawPaymentIds(raws, '01'.repeat(32), checkpoint)) {
    expect(pids).toEqual(paymentIdCandidates(raw.extra, '01'.repeat(32)))
    if (++seen === 2) expect(heartbeat).toBe(true)
  }
  expect(seen).toBe(100)
})

test('timestamps prioritize likely matches but never remove old or malformed evidence', () => {
  const tips = [{ detectedAt: new Date('2026-10-12T12:00:00Z') }]
  const transactions = [
    { hash: 'old', timestamp: '2025-01-01T00:00:00Z' },
    { hash: 'recent', timestamp: '2026-10-12T11:00:00Z' },
    { hash: 'mempool', timestamp: null },
    { hash: 'unknown', timestamp: 'bad-date' }
  ]
  expect(prioritizeRecentTransactions(transactions, tips).map(t => t.hash))
    .toEqual(['recent', 'mempool', 'unknown', 'old'])
  expect(transactions[0].hash).toBe('old')
})

test('an unknown tip initiation date leaves the exhaustive transaction order intact', () => {
  const rows = [{ hash: 'old', timestamp: '2020-01-01T00:00:00Z' }]
  expect(prioritizeRecentTransactions(rows, [{ detectedAt: null }])).toEqual(rows)
})
