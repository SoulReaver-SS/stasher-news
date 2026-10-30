import { string, ValidationError, number, object, array, boolean, date, mixed } from './yup'
import {
  MAX_POLL_CHOICE_LENGTH, MAX_TITLE_LENGTH, MAX_POLL_NUM_CHOICES,
  MIN_POLL_NUM_CHOICES, MAX_TERRITORY_DESC_LENGTH, POST_TYPES,
  TERRITORY_BILLING_TYPES, MAX_COMMENT_TEXT_LENGTH, MAX_POST_TEXT_LENGTH, MIN_TITLE_LENGTH,
  RESERVED_SUB_NAMES,
  BOOST_MAX, MAX_INVOICE_DESCRIPTION_LENGTH, MAX_WALLET_INVOICE_SATS, MAX_TIP_PICONEROS,
  BOOST_MIN,
  BOUNTY_MIN_PICONEROS,
  MAX_SEO_TITLE_LENGTH,
  MAX_SEO_TAGLINE_LENGTH
} from './constants'
import { SUPPORTED_CURRENCIES } from './currency'
import { NOSTR_MAX_RELAY_NUM, NOSTR_PUBKEY_BECH32, NOSTR_PUBKEY_HEX } from './nostr'
import { numWithUnits, piconerosToXmr } from './format'
import { GqlInputError } from './error'
import { SUBS } from '@/fragments/subs'
import { NAME_QUERY } from '@/fragments/users'
import { datePivot } from './time'
import { HEX_REGEXP } from './color'
import { NEVER_SEEN_FEE_PAY_IN_TYPES } from '@/lib/territoryVisibility'
import { normalizeAddendumText } from './item-addendum'

export async function validateSchema (schema, data, args) {
  try {
    if (typeof schema === 'function') {
      return await schema(args).validate(data)
    } else {
      return await schema.validate(data)
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new GqlInputError(`${e.path}: ${e.message}`)
    }
    throw e
  }
}

export function utf8ByteLength (value) {
  return new TextEncoder().encode(value || '').length
}

export function characterLength (value) {
  return Array.from(value || '').length
}

// truncate to at most `maxLength`. We add one character at a time (iterating by
// code point never splits a surrogate pair) and stop before exceeding the cap,
// measured by String.length since that's the unit clink's SDK actually enforces.
export function truncateToCharLength (value, maxLength) {
  let out = ''
  for (const char of value || '') {
    if (out.length + char.length > maxLength) break
    out += char
  }
  return out
}

const titleValidator = string().required('required').trim().max(
  MAX_TITLE_LENGTH,
  ({ max, value }) => `-${Math.abs(max - value.length)} characters remaining`
).min(MIN_TITLE_LENGTH, `must be at least ${MIN_TITLE_LENGTH} characters`)

const textValidator = (max) => string().trim().max(
  max,
  ({ max, value }) => `-${Math.abs(max - value.length)} characters remaining`
)
const nameValidator = string()
  .required('required')
  .matches(/^[\w_]+$/, 'only letters, numbers, and _')
  .max(32, 'too long')

export const intValidator = number().typeError('must be a number').integer('must be whole')

// Whole piconero amounts (JS Number inputs, BigInt DB columns). The piconero
// bounds in constants are BigInts; yup's .min/.max compare with JS >= which
// throws on mixed BigInt/Number ("Cannot mix BigInt and other types"), so
// callers pass Number(...) limits (1e9 is a safe integer). The safe-integer
// check keeps values exactly representable, so BigInt(value) downstream is lossless.
export const bigIntValidator = number().typeError('must be a number').integer('must be whole')
  .test('safe-integer', 'must be a safe integer', value => value == null || Number.isSafeInteger(value))

// Client-side XMR entry bound for the feed filters (settings + territory forms).
// The server re-validates the converted piconero value (settingsSchema /
// territorySchema fields use piconero bounds).
export const filterXmrValidator = number().typeError('must be a number').nullable()
  .min(-0.1, 'must be at least -0.1 XMR')
  .max(0.01, 'must be at most 0.01 XMR')

// Stricter than `^[^\s@]+@[^\s@]+$`: rejects empty parts, multiple `@`s, and
// requires a domain label with a TLD. Single source of truth for whether a
// string is a lightning address — used both to classify destinations
// (isLightningAddress) and to validate them (lightningAddressValidator).
const LIGHTNING_ADDRESS_REGEX = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
const LOCAL_DEV_ADDRESS_REGEX = /^[A-Za-z0-9._+-]+@(?:localhost|app)(?::\d+)?$/

export function isLightningAddress (value) {
  if (typeof value !== 'string') return false
  if (LIGHTNING_ADDRESS_REGEX.test(value)) return true
  if (process.env.NODE_ENV === 'development' && LOCAL_DEV_ADDRESS_REGEX.test(value)) return true
  return false
}

export const lightningAddressValidator = string().test(
  'lightning-address',
  'address is no good',
  value => !value || isLightningAddress(value))

async function usernameExists (name, { client, models }) {
  if (!client && !models) {
    throw new Error('cannot check for user')
  }
  // apollo client
  if (client) {
    const { data } = await client.query({ query: NAME_QUERY, variables: { name } })
    return !data.nameAvailable
  }

  // prisma client
  const user = await models.user.findUnique({ where: { name } })
  return !!user
}

async function getSubs (subNames, { client, models, me }) {
  if (!client && !models) {
    throw new Error('cannot check for territory')
  }

  let subs
  // apollo client
  if (client) {
    const { data } = await client.query({ query: SUBS, variables: { subNames } })
    subs = data?.subs
  } else {
    subs = await models.sub.findMany({
      where: { name: { in: subNames } },
      include: {
        billingPayIn: {
          select: {
            payInType: true
          }
        }
      }
    })
  }

  return subs
}

export const searchSchema = object({
  q: string().trim().max(100, 'must be at most 100 characters')
})

function subSelectSchemaMembers (postType, args) {
  return {
    subNames: array().of(string()).required('required').min(1, 'must post to at least one territory').max(5, 'can post to at most 5 territories').test(
      'subNames',
      `territories must exist and be valid for ${postType}`,
      async (subNames, { createError }) => {
        const subs = await getSubs(subNames, args)
        for (const subName of subNames) {
          const sub = subs.find(s => s.name === subName)
          if (!sub) return createError({ message: `territory ${subName} does not exist` })
          if (sub.status === 'STOPPED') return createError({ message: `territory ${subName} is not active` })
          // never-seen PENDING_FEE turf (spec 2026-08-17-turf-visibility-gate-design.md):
          // blocked for EVERYONE (owner included) until the fee lands — content must
          // not leak into home feeds through a turf that isn't live yet.
          if (sub.billingStatus === 'PENDING_FEE' && NEVER_SEEN_FEE_PAY_IN_TYPES.includes(sub.billingPayIn?.payInType)) {
            return createError({ message: `territory ${subName} is not live yet` })
          }
          if (!sub.postTypes.includes(postType)) return createError({ message: `territory ${subName} does not support ${postType}` })
        }
        return true
      })
  }
}

export const vaultEntrySchema = key => object({
  key: string().required('required').matches(key, `expected ${key}`),
  iv: string().required('required').hex().length(24, 'must be 24 characters long'),
  value: string().required('required').hex().min(2).max(1024 * 10)
})

// Single source of truth for LN-address payment field rules, derived from the
// provider's LNURL options. Both the send form and lnAddrSchema validate through
// these predicates, so the live form and the authoritative submit/server check
// cannot diverge. Each returns an error message, or null when the value is valid.
export function lnAddrAmountError (value, { min = 1, max } = {}) {
  if (value === '' || value == null) return 'required'
  const sats = Number(value)
  if (!Number.isSafeInteger(sats)) return 'must be a whole number'
  if (sats <= 0) return 'must be positive'
  if (sats < min) return `must be at least ${min}`
  if (max != null && sats > max) return `must be at most ${max}`
  return null
}

export function lnAddrCommentError (value, { commentAllowed } = {}) {
  const characters = characterLength(value)
  if (characters === 0) return null

  const max = commentAllowed || 0
  if (characters > max) return `comment must be at most ${max} characters`
  return null
}

export function lnAddrPayerError (field, value, { payerData } = {}) {
  const spec = payerData?.[field]
  if (!spec) return null
  // identifier is a checkbox: a mandatory one must be opted into (=== true), not
  // merely present (boolean().required() previously let an unchecked box through).
  const present = field === 'identifier' ? value === true : Boolean(value)
  if (spec.mandatory && !present) return 'required'
  if (field === 'email' && value && !string().email().isValidSync(value)) return 'bad email address'
  return null
}

export const lnAddrField = (name, getError) =>
  mixed().test(name, function (value) {
    const error = getError(value)
    return error ? this.createError({ message: error }) : true
  })

export const lnAddrSchema = (options = {}) => {
  // provider-supplied payerData must never redefine our core field validators
  const reserved = ['addr', 'amount', 'comment']
  return object({
    addr: lightningAddressValidator.required('required'),
    amount: lnAddrField('amount', value => lnAddrAmountError(value, options)),
    comment: lnAddrField('comment', value => lnAddrCommentError(value, options)),
    ...Object.fromEntries(
      Object.keys(options.payerData || {})
        .filter(field => !reserved.includes(field))
        .map(field => [field, lnAddrField(field, value => lnAddrPayerError(field, value, options))]))
  })
}

export function bountySchema (args) {
  return object({
    title: titleValidator,
    text: textValidator(MAX_POST_TEXT_LENGTH),
    bountyPiconeros: bigIntValidator
      .required('required')
      .min(Number(BOUNTY_MIN_PICONEROS), `must be at least ${BOUNTY_MIN_PICONEROS} piconeros`),
    moneroWallPricePiconeros: moneroWallPiconerosValidator,
    moneroWallThresholdPiconeros: moneroWallPiconerosValidator,
    ...subSelectSchemaMembers('BOUNTY', args)
  }).test('monero-wall-threshold', 'global unlock threshold must be at least the individual unlock threshold', moneroWallThresholdTest)
}

export function discussionSchema (args) {
  return object({
    title: titleValidator,
    text: textValidator(MAX_POST_TEXT_LENGTH),
    moneroWallPricePiconeros: moneroWallPiconerosValidator,
    moneroWallThresholdPiconeros: moneroWallPiconerosValidator,
    ...subSelectSchemaMembers('DISCUSSION', args)
  }).test('monero-wall-threshold', 'global unlock threshold must be at least the individual unlock threshold', moneroWallThresholdTest)
}

// Turf repost (2026-09-24): the target-turf checks for repostItem — target
// exists, is active, supports the item's post type — reusing the same rules
// (and error copy) as creation.
export function repostSchema (postType, args) {
  return object({
    ...subSelectSchemaMembers(postType, args)
  })
}

export function linkSchema (args) {
  return object({
    title: titleValidator,
    text: textValidator(MAX_POST_TEXT_LENGTH),
    url: string().url().required('required'),
    moneroWallPricePiconeros: moneroWallPiconerosValidator,
    moneroWallThresholdPiconeros: moneroWallPiconerosValidator,
    ...subSelectSchemaMembers('LINK', args)
  }).test('monero-wall-threshold', 'global unlock threshold must be at least the individual unlock threshold', moneroWallThresholdTest)
}

export function pollSchema ({ numExistingChoices = 0, ...args }) {
  return object({
    title: titleValidator,
    text: textValidator(MAX_POST_TEXT_LENGTH),
    options: array().of(
      string().trim().test('my-test', 'required', function (value) {
        return (this.path !== 'options[0]' && this.path !== 'options[1]') || value
      }).max(MAX_POLL_CHOICE_LENGTH,
        ({ max, value }) => `-${Math.abs(max - value.length)} characters remaining`
      )
    ).test({
      message: `at most ${MAX_POLL_NUM_CHOICES} choices`,
      test: arr => arr.length <= MAX_POLL_NUM_CHOICES - numExistingChoices
    }).test({
      message: `at least ${MIN_POLL_NUM_CHOICES} choices required`,
      test: arr => arr.length >= MIN_POLL_NUM_CHOICES - numExistingChoices
    }),
    pollExpiresAt: date().nullable().test({
      name: 'min',
      message: 'Expiration must be at least 1 day in the future',
      test: value => !value || value >= datePivot(new Date(), { days: 1 })
    }),
    randPollOptions: boolean(),
    ...subSelectSchemaMembers('POLL', args)
  })
}

// Turf owner premiums (piconeros, 0..0.01 XMR). Server-side the GraphQL BigInt
// scalar delivers JS BigInts, which yup's number() rejects at its type check
// (bigIntValidator above is Numbers-only), so bounds run as a raw-comparing
// test that also accepts integral Number/string input (client form state).
// The static ceiling matches the maxTurfPremiumPiconeros config default; the
// runtime clamp lives in premiumPiconeros (api/monero/turfFeeRouting.js).
const turfPremiumValidator = mixed()
  .nullable()
  .test('turf-premium-bounds', 'must be a whole piconero amount', function (value) {
    if (value == null) return true
    let piconeros
    try {
      piconeros = BigInt(value)
    } catch {
      return this.createError({ message: 'must be a whole piconero amount' })
    }
    if (piconeros < 0n) return this.createError({ message: 'must be at least 0' })
    if (piconeros > 10_000_000_000n) return this.createError({ message: 'must be at most 0.01 XMR' })
    return true
  })

// Monerowall price/threshold: whole piconeros, nullable, > 0. Accepts
// BigInt/Number/string like turfPremiumValidator (GraphQL BigInt server-side,
// string piconeros client-side). Cross-field + floor checks live in
// lib/monero-wall (moneroWallConfigError) so server and client agree.
const moneroWallPiconerosValidator = mixed()
  .nullable()
  .test('monero-wall-piconeros', 'must be a whole piconero amount', function (value) {
    if (value == null) return true
    let piconeros
    try {
      piconeros = BigInt(value)
    } catch {
      return this.createError({ message: 'must be a whole piconero amount' })
    }
    if (piconeros <= 0n) return this.createError({ message: 'must be greater than zero' })
    return true
  })

const moneroWallThresholdTest = function (value) {
  const { moneroWallPricePiconeros: price, moneroWallThresholdPiconeros: threshold } = value ?? {}
  if (price == null || threshold == null) return true
  try {
    return BigInt(threshold) >= BigInt(price)
  } catch {
    return true
  }
}

export function territorySchema (args) {
  return object({
    name: nameValidator
      .test(
        'name',
        'territory name must be available',
        async (name, { createError }) => {
          if (!name || !name.length) return createError({ message: 'territory name is required' })
          if (RESERVED_SUB_NAMES.includes(name)) return createError({ message: 'territory name is reserved' })
          const [sub] = await getSubs([name], args)
          if (!sub) return true
          const editing = !!args.sub?.name && args.sub.name === name
          const isArchived = sub.status === 'STOPPED'
          if (editing || isArchived) return true
          return createError({ message: 'territory name is already taken' })
        })
      .test('jobs-rename', 'the jobs turf cannot be renamed', function (name) {
        return args.sub?.name !== 'jobs' || name === 'jobs'
      }),
    desc: string().required('required').trim().max(
      MAX_TERRITORY_DESC_LENGTH,
      ({ max, value }) => `-${Math.abs(max - value.length)} characters remaining`
    ),
    postsPiconerosFilter: intValidator
      .nullable()
      .min(-100000000000, 'must be at least -0.1 XMR')
      .max(10000000000, 'must be at most 0.01 XMR'),
    postPremiumPiconeros: turfPremiumValidator,
    commentPremiumPiconeros: turfPremiumValidator,
    postTypes: array()
      .of(string().oneOf(POST_TYPES))
      .min(1, 'must support at least one post type')
      .test('job-exclusivity', function (postTypes) {
        if (this.parent?.name === 'jobs') {
          return postTypes?.includes('JOB')
            ? true
            : this.createError({ message: 'the jobs turf must support jobs' })
        }
        if (postTypes?.includes('JOB') && !postTypes.some(t => t !== 'JOB')) {
          return this.createError({ message: 'jobs can only be hosted by the jobs turf' })
        }
        return true
      }),
    billingType: string().required('required').oneOf(TERRITORY_BILLING_TYPES, 'required'),
    nsfw: boolean()
  })
}

export function territoryTransferSchema ({ me, ...args }) {
  return object({
    userName: nameValidator
      .test({
        name: 'name',
        test: async name => {
          if (!name || !name.length) return false
          return await usernameExists(name, args)
        },
        message: 'user does not exist'
      })
      .test({
        name: 'name',
        test: name => !me || me.name !== name,
        message: 'cannot transfer to yourself'
      })
  })
}

// Custom Domain validation schema
export function customDomainSchema (args) {
  // a subdomain must have at least 3 labels (www.example.com at minimum)
  // each label must be 1-63 chars
  // the total length must be at most 253 chars
  // and no leading/trailing dashes
  const regex = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/i
  return object({
    domainName: string()
      .trim()
      .required('domain name is required')
      .max(253, 'domain must be at most 253 characters')
      .matches(regex, {
        message: 'CNAME records only support subdomains (e.g., www.example.com, sub.example.com), no leading/trailing dashes, each label 1-63 chars, at least two dots'
      })
  })
}

// hex color regex (#rgb, #rgba, #rrggbb, #rrggbbaa)
const hexColorValidator = string()
  .trim()
  .matches(
    HEX_REGEXP,
    'must be a valid hex color (e.g. #ff6600)'
  )

export const subBrandingSchema = object({
  // appearance
  primaryColor: hexColorValidator.nullable(),
  secondaryColor: hexColorValidator.nullable(),
  linkColor: hexColorValidator.nullable(),
  logoId: intValidator.nullable().positive('must be positive'),

  // discovery / SEO
  title: string().trim().max(MAX_SEO_TITLE_LENGTH, `must be at most ${MAX_SEO_TITLE_LENGTH} characters`).nullable(),
  tagline: string().trim().max(MAX_SEO_TAGLINE_LENGTH, `must be at most ${MAX_SEO_TAGLINE_LENGTH} characters`).nullable(),
  faviconId: intValidator.nullable().positive('must be positive')
})

export function userSchema (args) {
  return object({
    name: nameValidator
      .test({
        name: 'name',
        test: async name => {
          if (!name || !name.length) return false
          return !(await usernameExists(name, args))
        },
        message: 'taken'
      })
  })
}

export const commentSchema = object({
  text: textValidator(MAX_COMMENT_TEXT_LENGTH).required('required')
})

// Post-window addendum (2026-10-04 spec): empty text is a valid, intentional
// clear — the cap and monerowall-marker rules live in normalizeAddendumText so
// client form and server mutation enforce the identical string rules.
export const itemAddendumSchema = object({
  text: string().trim().defined().test('addendum-text', function (value) {
    try {
      normalizeAddendumText(value)
      return true
    } catch (error) {
      return this.createError({ message: error.message })
    }
  })
})

export const jobSchema = args => object({
  title: titleValidator,
  company: string().required('required').trim(),
  text: textValidator(MAX_POST_TEXT_LENGTH).required('required'),
  url: string()
    .or([string().email(), string().url()], 'invalid url or email')
    .required('required'),
  location: string().test(
    'no-remote',
    "don't write remote, just check the box",
    v => !v?.match(/\bremote\b/gi))
    .when('remote', {
      is: (value) => !value,
      then: schema => schema.required('required').trim()
    })
})

export const emailSchema = object({
  email: string().email('email is no good').required('required')
})

export const emailTokenSchema = object({
  token: string().required('required').trim().matches(/^[0-9a-z]{6}$/i, 'must be 6 alphanumeric characters')
})

export const urlSchema = object({
  url: string().url().required('required')
})

export const namedUrlSchema = object({
  text: string().required('required').trim(),
  url: string().url().required('required')
})

// XMR decimal amount entry (tip modal). Accepts a positive decimal (e.g. "0.001");
// submit converts to piconeros via xmrToPiconeros.
export const xmrAmountSchema = object({
  amount: number().typeError('must be a number').required('required').positive('must be positive')
})

const xmrValidator = number().typeError('must be a number').positive('must be positive')

export const amountSchema = object({
  amount: intValidator.required('required').positive('must be positive')
})

export const walletInvoiceSchema = object({
  amount: intValidator.required('required').positive('must be positive')
    .max(MAX_WALLET_INVOICE_SATS, `must be at most ${numWithUnits(MAX_WALLET_INVOICE_SATS, { abbreviate: false })}`),
  description: string().trim().test({
    name: 'max-bytes',
    message: 'description is too long',
    test: value => utf8ByteLength(value) <= MAX_INVOICE_DESCRIPTION_LENGTH
  })
})

export const boostValidator = intValidator
  .min(BOOST_MIN, `must be at least ${piconerosToXmr(BigInt(BOOST_MIN))}`)
  .max(BOOST_MAX, `must be less than or equal to ${piconerosToXmr(BigInt(BOOST_MAX))}`)

export const boostSchema = object({
  amount: boostValidator.required('required').positive('must be positive')
})

export const actSchema = object({
  piconeros: intValidator.required('required').positive('must be positive')
    .when(['act'], ([act], schema) => {
      if (act === 'BOOST') {
        return boostValidator
      }
      if (act === 'TIP') {
        // a zap's 70% single-recipient P2P share can't exceed MAX_OUTGOING_MSATS or it can't be
        // wrapped/delivered to the recipient (it would silently degrade to credits) — see MAX_TIP_PICONEROS
        return schema.max(MAX_TIP_PICONEROS, `must be at most ${numWithUnits(MAX_TIP_PICONEROS, { abbreviate: false })}`)
      }
      return schema
    }),
  act: string().required('required').oneOf(['TIP', 'DONT_LIKE_THIS', 'BOOST'])
})

export const settingsSchema = object().shape({
  tipDefault: xmrValidator.required('required').positive('must be positive'),
  tipRandom: boolean(),
  tipRandomMin: xmrValidator.nullable().positive('must be positive')
    .when(['tipRandom', 'tipRandomMax'], ([enabled, max], schema) => {
      let res = schema
      if (!enabled) return res
      if (max) {
        res = schema.required('minimum and maximum must either both be omitted or specified').nonNullable()
      }
      return res.lessThan(max, 'must be less than maximum')
    }),
  tipRandomMax: xmrValidator.nullable().positive('must be positive')
    .when(['tipRandom', 'tipRandomMin'], ([enabled, min], schema) => {
      let res = schema
      if (!enabled) return res
      if (min) {
        res = schema.required('minimum and maximum must either both be omitted or specified').nonNullable()
      }
      return res.moreThan(min, 'must be more than minimum')
    }),
  fiatCurrency: string().required('required').oneOf(SUPPORTED_CURRENCIES),
  nostrPubkey: string().nullable()
    .or([
      string().nullable().matches(NOSTR_PUBKEY_HEX, 'must be 64 hex chars'),
      string().nullable().matches(NOSTR_PUBKEY_BECH32, 'invalid bech32 encoding')], 'invalid pubkey'),
  nostrRelays: array().of(
    string().ws().transform(relay => relay.startsWith('wss://') ? relay : `wss://${relay}`)
  ).max(NOSTR_MAX_RELAY_NUM,
    ({ max, value }) => `${Math.abs(max - value.length)} too many`),
  hideBookmarks: boolean(),
  emailNotifications: boolean(),
  newsletterOptIn: boolean(),
  hideStashAmount: boolean(),
  hideGithub: boolean(),
  hideNostr: boolean(),
  hideTwitter: boolean(),
  noReferralLinks: boolean(),
  postsPiconerosFilter: intValidator.nullable().min(-100000000000, 'must be at least -0.1 XMR').max(10000000000, 'must be at most 0.01 XMR'),
  commentsPiconerosFilter: intValidator.nullable().min(-100000000000, 'must be at least -0.1 XMR').max(10000000000, 'must be at most 0.01 XMR')
  // exclude from cyclic analysis. see https://github.com/jquense/yup/issues/720
}, [['tipRandomMax', 'tipRandomMin']])

const warningMessage = 'If I logout, even accidentally, I will never be able to access my account again'
export const lastAuthRemovalSchema = object({
  warning: string().matches(warningMessage, 'does not match').required('required')
})

export const withdrawlSchema = object({
  invoice: string().required('required').trim(),
  maxFee: intValidator.required('required').min(0, 'must be at least 0')
})

export const bioSchema = object({
  text: string().required('required').trim()
})

export const inviteSchema = object({
  gift: intValidator.positive('must be greater than 0').required('required'),
  limit: intValidator.positive('must be positive'),
  description: string().trim().max(40, 'must be at most 40 characters'),
  id: string().matches(/^[\w-_]+$/, 'only letters, numbers, underscores, and hyphens').min(8, 'must be at least 8 characters').max(32, 'must be at most 32 characters')
})

export const pushSubscriptionSchema = object({
  endpoint: string().url().required('required').trim(),
  p256dh: string().required('required').trim(),
  auth: string().required('required').trim()
})

export const lud18PayerDataSchema = (k1) => object({
  name: string(),
  pubkey: string(),
  email: string().email('bad email address'),
  identifier: string()
})
