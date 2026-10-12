/* eslint-env jest */

// Unit tests for the rewards-phase timing helper (Finding 3). The 2026-10-12
// distribution outran pg-boss's execution budget while running to completion;
// these start/finish lines make slow-but-legitimate phases distinguishable from
// hangs without ever touching money effects: the helper always invokes the
// callback, always returns/rethrows its exact outcome, and logs only code-owned
// fields (phase, outcome, durationMs and numeric ids supplied as context).

import { withRewardsPhase } from '@/worker/rewardsPhase'
import { logInfo } from '../../lib/logger'

jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

beforeEach(() => {
  logInfo.mockReset()
})

test('returns the callback result by identity and logs the completed outcome with a duration', async () => {
  const result = { id: 7 }
  await expect(withRewardsPhase('payout-build', async () => result, { accountIndex: 3 })).resolves.toBe(result)
  expect(logInfo).toHaveBeenNthCalledWith(1, { phase: 'payout-build', accountIndex: 3 }, 'rewards phase started')
  expect(logInfo).toHaveBeenNthCalledWith(2,
    expect.objectContaining({ phase: 'payout-build', accountIndex: 3, outcome: 'completed', durationMs: expect.any(Number) }),
    'rewards phase finished')
  expect(logInfo.mock.calls[1][0].durationMs).toBeGreaterThanOrEqual(0)
})

test('rethrows the exact same error object and logs the failed outcome with a duration', async () => {
  const err = new Error('send failed')
  await expect(withRewardsPhase('payout-relay', async () => { throw err }, { accountIndex: 0 })).rejects.toBe(err)
  expect(logInfo).toHaveBeenNthCalledWith(1, { phase: 'payout-relay', accountIndex: 0 }, 'rewards phase started')
  expect(logInfo).toHaveBeenNthCalledWith(2,
    expect.objectContaining({ phase: 'payout-relay', accountIndex: 0, outcome: 'failed', durationMs: expect.any(Number) }),
    'rewards phase finished')
})

test('a synchronous callback throw is rethrown by identity with the failed outcome', async () => {
  const err = new Error('sync throw')
  await expect(withRewardsPhase('distribution-ledger', () => { throw err })).rejects.toBe(err)
  expect(logInfo).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: 'failed' }), 'rewards phase finished')
})

test('logs the start line before the callback settles (never-resolving callback, bounded assertion timeout)', async () => {
  const neverSettles = withRewardsPhase('wallet-initial-sync', () => new Promise(() => {}))
  // Assertion timeout, NOT awaiting the phase promise: it never resolves, so
  // awaiting it would hang the suite.
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(logInfo).toHaveBeenCalledTimes(1)
  expect(logInfo).toHaveBeenCalledWith({ phase: 'wallet-initial-sync' }, 'rewards phase started')
  expect(neverSettles).toBeInstanceOf(Promise)
})

test('a throwing logger neither blocks the callback nor masks its result or exception', async () => {
  logInfo.mockImplementation(() => { throw new Error('logger exploded') })
  await expect(withRewardsPhase('distribution-completion', async () => 42)).resolves.toBe(42)
  const err = new Error('wallet exploded')
  await expect(withRewardsPhase('distribution-completion', async () => { throw err })).rejects.toBe(err)
})

test('exception text and the exception object never reach the phase logs', async () => {
  const fakePrivateKey = 'aa'.repeat(32)
  const err = new Error(`signing failed near ${fakePrivateKey}`)
  await expect(withRewardsPhase('payout-relay', async () => { throw err }, { accountIndex: 2 })).rejects.toBe(err)
  expect(logInfo).toHaveBeenCalled()
  expect(JSON.stringify(logInfo.mock.calls)).not.toContain(fakePrivateKey)
  for (const call of logInfo.mock.calls) {
    for (const arg of call) {
      expect(arg).not.toBe(err)
    }
  }
})
