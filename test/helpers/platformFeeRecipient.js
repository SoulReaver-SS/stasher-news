/* eslint-env jest */
// Test stand-in for api/monero/feePool.js resolvePlatformFeeRecipient in the
// real-DB payIn engine suites: integrated platform fee intents need a real
// MoneroAccount row (SubFeePidMap.recipient_account_id is an FK), but those
// suites must not depend on the dev stack's registered rewards wallet. Upserts
// one dedicated row keyed by a fixed, test-only stagenet address (valid
// base58 + checksum, never a real wallet) and NEVER deletes it — intents
// reference it with ON DELETE RESTRICT.
//
// Use from a jest.mock factory (factories cannot close over imports):
//   resolvePlatformFeeRecipient: (models) => require('../helpers/platformFeeRecipient').testPlatformFeeRecipient(models)
import { moneroUriAmountPiconeros } from '@/lib/format'

export const TEST_PLATFORM_FEE_ADDRESS = '53fNxyrnpzq9b7oZQt3SHsGJgyLLXEJGDP2G979eNKNdVjqJPC8xg6hcTNGgFKocCVj1EmSNAyrBf6uHjeeDNhPb9YHQX88'

export async function testPlatformFeeRecipient (models) {
  return await models.moneroAccount.upsert({
    where: { address_network: { address: TEST_PLATFORM_FEE_ADDRESS, network: 'STAGENET' } },
    create: { address: TEST_PLATFORM_FEE_ADDRESS, network: 'STAGENET', label: 'test_platform_fee_recipient', status: 'ACTIVE' },
    update: {}
  })
}

// Assert a payIn prospect/row carries an integrated-address PLATFORM fee
// invoice: a 16-hex pid, a 106-char integrated destination, no subaddress
// coordinates, and a retained intent frozen to the test recipient with the
// expected classification and full quote. Returns the intent row.
export async function expectPlatformFeeLeg (models, prospect, feeType) {
  expect(prospect.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(prospect.moneroSubaddressMajor ?? null).toBeNull()
  expect(prospect.moneroSubaddressMinor ?? null).toBeNull()
  const address = decodeURIComponent(prospect.moneroUri.slice('monero:'.length).split('?')[0])
  expect(address).toHaveLength(106)
  const feeMap = await models.subFeePidMap.findUnique({ where: { paymentId: prospect.moneroPaymentId } })
  expect(feeMap).toMatchObject({ feeType, ownerUserId: null, recipientAddress: TEST_PLATFORM_FEE_ADDRESS })
  expect(feeMap.amountPiconeros).toBe(moneroUriAmountPiconeros(prospect.moneroUri))
  return feeMap
}
