/* eslint-env jest */

// PayIn.feeObserved owner-leg coverage (Task 7, turf-owner-revenue):
// mock-based unit tests proving the resolver flips true when EITHER a
// FeeObservation (platform fee-pool flow) OR an ObservedSubFee receipt
// (owner-direct flow, Task 5) exists for the payIn.
//
// The jest.mock preamble stubs the heavy transitive deps api/resolvers/payIn.js
// pulls in (mirroring test/api/monero/turfFeeRouting.itemCreate.test.js):
//   - ../../api/payIn          — the payIn engine instantiates a Prisma client
//                                and loads every payIn type module at import
//                                time; only `retry` is used by this resolver
//                                module, and not in the field under test.
//   - ../../api/resolvers/item — the full item resolver tree (lexical, upload).
//                                payIn.js imports getItem/getItemsById; neither
//                                runs in the feeObserved field resolver.
//   - ../../api/resolvers/sub  — the sub resolver tree (webPush, monero
//                                territoryFee, lexical). payIn.js imports
//                                getSub; it does not run here either.
// Relative paths are required in jest.mock because next/jest registers no
// `@/*` moduleNameMapper — see the engine test's preamble comment for details.
// babel-jest hoists these jest.mock calls above the imports below, so the
// stubs register before the resolvers module is evaluated.

jest.mock('../../api/payIn', () => ({ __esModule: true, retry: jest.fn() }))
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true, getItem: jest.fn(), getItemsById: jest.fn()
}))
jest.mock('../../api/resolvers/sub', () => ({ __esModule: true, getSub: jest.fn() }))

describe('PayIn.feeObserved (owner legs)', () => {
  it('is true when an ObservedSubFee receipt exists but no FeeObservation', async () => {
    const models = {
      feeObservation: { findFirst: async () => null },
      observedSubFee: { findFirst: async () => ({ id: 1, state: 'DETECTED' }) }
    }
    const resolvers = (await import('../../api/resolvers/payIn')).default
    expect(await resolvers.PayIn.feeObserved({ id: 5 }, {}, { models })).toBe(true)
  })
  it('stays false when neither table has a row', async () => {
    const models = {
      feeObservation: { findFirst: async () => null },
      observedSubFee: { findFirst: async () => null }
    }
    const resolvers = (await import('../../api/resolvers/payIn')).default
    expect(await resolvers.PayIn.feeObserved({ id: 5 }, {}, { models })).toBe(false)
  })
})

describe('PayIn.feeCovered (integrated payment-id invoices)', () => {
  // URI quotes 0.001 XMR = 1e9 piconeros
  const payIn = { id: 5, moneroPaymentId: 'a1b2c3d4e5f60718', moneroUri: 'monero:4INT?tx_amount=0.001' }
  // Aggregates honour the where clause the resolver sends: provisional
  // (height NULL) money is only counted when the query does not exclude it.
  const modelsWith = ({ verified = 0n, provisional = 0n }) => {
    const sum = where => ({ _sum: { piconeros: where.height ? verified : verified + provisional } })
    return {
      feeObservation: { aggregate: jest.fn(async ({ where }) => sum(where)) },
      observedSubFee: { aggregate: jest.fn(async () => ({ _sum: { piconeros: 0n } })) }
    }
  }

  it('does not report coverage from provisional (unverified) money', async () => {
    const resolvers = (await import('../../api/resolvers/payIn')).default
    const models = modelsWith({ provisional: 5_000_000_000n })
    expect(await resolvers.PayIn.feeCovered(payIn, {}, { models })).toBe(false)
    // and only live-state receipts are counted, matching the settle gate
    expect(models.feeObservation.aggregate).toHaveBeenCalledWith({
      _sum: { piconeros: true },
      where: { payInId: 5, state: { in: ['DETECTED', 'CONFIRMED'] }, height: { not: null } }
    })
  })

  it('reports coverage once verified receipts reach the full quote', async () => {
    const resolvers = (await import('../../api/resolvers/payIn')).default
    expect(await resolvers.PayIn.feeCovered(payIn, {}, { models: modelsWith({ verified: 1_000_000_000n }) })).toBe(true)
  })
})

describe('PayIn.feeObserved (owner receipt states)', () => {
  it('ignores refused/reversed owner receipts', async () => {
    const findFirst = jest.fn(async () => null)
    const models = { feeObservation: { findFirst: async () => null }, observedSubFee: { findFirst } }
    const resolvers = (await import('../../api/resolvers/payIn')).default
    expect(await resolvers.PayIn.feeObserved({ id: 5 }, {}, { models })).toBe(false)
    expect(findFirst).toHaveBeenCalledWith({ where: { payInId: 5, state: { in: ['DETECTED', 'CONFIRMED'] } } })
  })
})
