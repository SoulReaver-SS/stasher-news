/* eslint-env jest */

// Unit tests for the referral-payout budget allocator. These run without a
// database: the only model call is the referrer's receiving-account lookup.
//
// The founder account stasher is excluded from referral payouts, but its
// would-be 10% must still consume its place in the capped referral budget.
// Otherwise a later referrer could receive the excluded commission, leaking
// money that is required to roll over instead.

import { allocateReferralPayouts } from '@/worker/rewardsDistributor'
import { USER_ID } from '@/lib/constants'

function modelsWithAccounts (ownerIds) {
  return {
    moneroAccount: {
      findFirst: async ({ where }) => ownerIds.includes(where.ownerUserId)
        ? { address: `addr-${where.ownerUserId}` }
        : null
    }
  }
}

test('an excluded stasher referral consumes its capped budget instead of funding another referrer', async () => {
  const referralByReferrer = new Map([
    [USER_ID.stasher, { piconeros: 10n }],
    [42, { piconeros: 10n }]
  ])

  const { rows, remainingBudget } = await allocateReferralPayouts(
    modelsWithAccounts([USER_ID.stasher, 42]), referralByReferrer, 15n)

  // stasher's 10 is reserved (not paid); the later referrer gets only the
  // remaining 5, and the whole budget is accounted for.
  expect(rows).toEqual([{ curatorId: 42, recipientAddress: 'addr-42', piconeros: 5n }])
  expect(remainingBudget).toBe(0n)
})

test('stasher budget reservation does not depend on it having a payout account', async () => {
  const referralByReferrer = new Map([
    [USER_ID.stasher, { piconeros: 10n }],
    [42, { piconeros: 10n }]
  ])

  const { rows, remainingBudget } = await allocateReferralPayouts(
    modelsWithAccounts([42]), referralByReferrer, 15n)

  expect(rows).toEqual([{ curatorId: 42, recipientAddress: 'addr-42', piconeros: 5n }])
  expect(remainingBudget).toBe(0n)
})

test('an addressless non-excluded referrer still does not consume budget', async () => {
  const referralByReferrer = new Map([
    [43, { piconeros: 10n }],
    [42, { piconeros: 10n }]
  ])

  const { rows, remainingBudget } = await allocateReferralPayouts(
    modelsWithAccounts([42]), referralByReferrer, 15n)

  expect(rows).toEqual([{ curatorId: 42, recipientAddress: 'addr-42', piconeros: 10n }])
  expect(remainingBudget).toBe(5n)
})

test('a configured excluded referrer reserves its capped commission instead of paying it', async () => {
  const referralByReferrer = new Map([
    [42, { piconeros: 10n }],
    [43, { piconeros: 10n }]
  ])

  const { rows, remainingBudget } = await allocateReferralPayouts(
    modelsWithAccounts([42, 43]), referralByReferrer, 15n, [42, 42])

  // The excluded referrer's 10 is reserved (not paid, not redirected); the
  // later referrer receives only the remaining 5 and the whole budget closes.
  expect(rows).toEqual([{ curatorId: 43, recipientAddress: 'addr-43', piconeros: 5n }])
  expect(remainingBudget).toBe(0n)
})

test('the configured exclusion list supplements, never replaces, the founder exclusion', async () => {
  const referralByReferrer = new Map([
    [USER_ID.stasher, { piconeros: 10n }],
    [42, { piconeros: 10n }],
    [43, { piconeros: 10n }]
  ])

  const { rows, remainingBudget } = await allocateReferralPayouts(
    modelsWithAccounts([USER_ID.stasher, 42, 43]), referralByReferrer, 25n, [42])

  expect(rows).toEqual([{ curatorId: 43, recipientAddress: 'addr-43', piconeros: 5n }])
  expect(remainingBudget).toBe(0n)
})

test('an exhausted referral budget pays nobody', async () => {
  const referralByReferrer = new Map([[42, { piconeros: 10n }]])

  const { rows, remainingBudget } = await allocateReferralPayouts(
    modelsWithAccounts([42]), referralByReferrer, 0n)

  expect(rows).toEqual([])
  expect(remainingBudget).toBe(0n)
})
