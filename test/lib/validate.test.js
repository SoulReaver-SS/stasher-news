/* eslint-env jest */
import { settingsSchema, territorySchema, filterXmrValidator, bountySchema, actSchema, validateSchema } from '@/lib/validate'
import { BOUNTY_MIN_PICONEROS, BOOST_MIN, BOOST_MAX } from '@/lib/constants'
import { GqlInputError, E_BAD_INPUT } from '@/lib/error'
import { formatGraphqlError } from '@/lib/formatGraphqlError'

describe('validateSchema input errors (#23)', () => {
  it('rethrows a yup failure as GqlInputError with the field path', async () => {
    const err = await validateSchema(actSchema, { piconeros: BOOST_MIN - 1, act: 'BOOST' }).catch(e => e)
    expect(err).toBeInstanceOf(GqlInputError)
    expect(err.extensions.code).toBe(E_BAD_INPUT)
    expect(err.message).toBe('piconeros: must be at least 0.001 XMR')
  })
  it('is not masked as an internal server error in prod', async () => {
    const err = await validateSchema(actSchema, { piconeros: BOOST_MIN - 1, act: 'BOOST' }).catch(e => e)
    const formatted = formatGraphqlError(
      { message: err.message, extensions: err.extensions },
      err,
      { isProd: true, logError: () => {} }
    )
    expect(formatted.message).toBe('piconeros: must be at least 0.001 XMR')
    expect(formatted.extensions.code).toBe(E_BAD_INPUT)
  })
  it('passes valid data through', async () => {
    await expect(validateSchema(actSchema, { piconeros: BOOST_MIN, act: 'BOOST' }))
      .resolves.toEqual(expect.objectContaining({ piconeros: BOOST_MIN }))
  })
})

describe('boost bounds are reported in XMR (#23)', () => {
  it('min and max messages use XMR, not sats', async () => {
    await expect(actSchema.validate({ piconeros: BOOST_MIN - 1, act: 'BOOST' })).rejects.toThrow('must be at least 0.001 XMR')
    await expect(actSchema.validate({ piconeros: BOOST_MAX + 1, act: 'BOOST' })).rejects.toThrow('must be less than or equal to 1 XMR')
  })
})

describe('settingsSchema piconero server bounds', () => {
  it('accepts the -0.1 XMR floor, the posting-fee default, and 0 comments filter', async () => {
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(-100000000000)).resolves.toBe(-100000000000)
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(1000000000)).resolves.toBe(1000000000)
    await expect(settingsSchema.fields.commentsPiconerosFilter.validate(0)).resolves.toBe(0)
  })
  it('rejects beyond -0.1..0.01 XMR', async () => {
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(10000000001)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(settingsSchema.fields.commentsPiconerosFilter.validate(-100000000001)).rejects.toThrow(/at least -0.1 XMR/)
  })
})

describe('territorySchema piconero bounds', () => {
  const schema = territorySchema({})
  it('accepts the -0.1 XMR turf default', async () => {
    await expect(schema.fields.postsPiconerosFilter.validate(-100000000000)).resolves.toBe(-100000000000)
    await expect(schema.fields.postsPiconerosFilter.validate(1000000000)).resolves.toBe(1000000000)
  })
  it('rejects beyond -0.1..0.01 XMR', async () => {
    await expect(schema.fields.postsPiconerosFilter.validate(10000000001)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(schema.fields.postsPiconerosFilter.validate(-100000000001)).rejects.toThrow(/at least -0.1 XMR/)
  })
})

describe('filterXmrValidator client bounds', () => {
  it('accepts -0.1, 0.001 and 0', async () => {
    await expect(filterXmrValidator.validate(-0.1)).resolves.toBe(-0.1)
    await expect(filterXmrValidator.validate(0.001)).resolves.toBe(0.001)
    await expect(filterXmrValidator.validate(0)).resolves.toBe(0)
  })
  it('rejects beyond -0.1..0.01 XMR', async () => {
    await expect(filterXmrValidator.validate(0.011)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(filterXmrValidator.validate(-0.11)).rejects.toThrow(/at least -0.1 XMR/)
  })
})

describe('bountySchema piconero validation (A-13)', () => {
  const schema = bountySchema({})
  const field = schema.fields.bountyPiconeros
  it('accepts the floor amount (BigInt limit compared without TypeError)', async () => {
    await expect(field.validate(Number(BOUNTY_MIN_PICONEROS))).resolves.toBe(Number(BOUNTY_MIN_PICONEROS))
  })
  it('rejects one piconero below the floor', async () => {
    await expect(field.validate(Number(BOUNTY_MIN_PICONEROS) - 1)).rejects.toThrow(/at least/)
  })
  it('rejects non-whole and non-number amounts', async () => {
    await expect(field.validate(1.5)).rejects.toThrow(/whole/)
    await expect(field.validate('nope')).rejects.toThrow(/number/)
  })
  it('rejects amounts beyond safe-integer range (lossy BigInt conversion)', async () => {
    await expect(field.validate(1e30)).rejects.toThrow(/safe integer/)
  })
  it('rejects a missing amount', async () => {
    await expect(field.validate(undefined)).rejects.toThrow(/required/)
  })
  it('whole schema accepts a complete bounty and rejects a missing amount', async () => {
    const withModels = bountySchema({
      models: {
        sub: {
          findMany: async () => [{
            name: 'monero', status: 'ACTIVE', postTypes: ['LINK', 'DISCUSSION', 'POLL', 'BOUNTY']
          }]
        }
      }
    })
    await expect(withModels.validate({
      title: 'test title',
      text: 'x',
      subNames: ['monero'],
      bountyPiconeros: Number(BOUNTY_MIN_PICONEROS)
    })).resolves.toEqual(expect.objectContaining({ bountyPiconeros: Number(BOUNTY_MIN_PICONEROS) }))
    await expect(withModels.validate({
      title: 'test title',
      text: 'x',
      subNames: ['monero']
    })).rejects.toThrow(/required/)
  })
})

describe('territorySchema job exclusivity', () => {
  const schema = (oldName) => territorySchema({
    models: { sub: { findMany: async () => [] } },
    ...(oldName ? { sub: { name: oldName } } : {})
  })
  const turf = (name, postTypes) => ({
    name,
    desc: 'd',
    postsPiconerosFilter: null,
    postPremiumPiconeros: null,
    commentPremiumPiconeros: null,
    postTypes,
    billingType: 'MONTHLY',
    billingAutoRenew: false,
    nsfw: false
  })

  it('rejects JOB as the only type on a non-jobs turf', async () => {
    await expect(schema().validate(turf('myturf', ['JOB'])))
      .rejects.toThrow(/jobs can only be hosted by the jobs turf/)
  })
  it('accepts JOB alongside a regular type on a non-jobs turf', async () => {
    await expect(schema().validate(turf('myturf', ['LINK', 'JOB']))).resolves.toBeTruthy()
  })
  it('accepts the jobs turf carrying JOB', async () => {
    await expect(schema().validate(turf('jobs', ['LINK', 'JOB']))).resolves.toBeTruthy()
  })
  it('rejects the jobs turf without JOB', async () => {
    await expect(schema().validate(turf('jobs', ['LINK'])))
      .rejects.toThrow(/the jobs turf must support jobs/)
  })
  it('rejects renaming the jobs turf', async () => {
    await expect(schema('jobs').validate(turf('jobs2', ['LINK', 'JOB'])))
      .rejects.toThrow(/the jobs turf cannot be renamed/)
  })
  it('rejects a duplicated JOB on a non-jobs turf', async () => {
    await expect(schema().validate(turf('myturf', ['JOB', 'JOB'])))
      .rejects.toThrow(/jobs can only be hosted by the jobs turf/)
  })
  it('accepts an in-place edit of the jobs turf', async () => {
    await expect(schema('jobs').validate(turf('jobs', ['LINK', 'JOB']))).resolves.toBeTruthy()
  })
  it('allows a JOB-carrying non-jobs turf to take a free jobs name (availability rule still governs)', async () => {
    await expect(schema('myturf').validate(turf('jobs', ['LINK', 'JOB']))).resolves.toBeTruthy()
  })
})

describe('settingsSchema emailNotifications', () => {
  test('accepts a boolean', async () => {
    await expect(settingsSchema.fields.emailNotifications.validate(false)).resolves.toBe(false)
  })

  test('rejects non-booleans', async () => {
    await expect(settingsSchema.fields.emailNotifications.validate('yes')).rejects.toThrow()
  })
})
