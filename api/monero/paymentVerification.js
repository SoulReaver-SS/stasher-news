import { createHash } from 'node:crypto'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import {
  canonicalPaymentJson,
  decodeReceivingIdentity
} from './paymentClaims'
import { loadPaymentProof } from './paymentProofStore'
import {
  classifyOutputKeys,
  parseKeyBundleHex,
  parseTxExtraStrict
} from './paymentKeyStructure'

// Shared trusted confirmed whole-payment verification (Finding #1, Task 5).
//
// Two entry points, one result contract:
//
//   verifyPaymentTransaction    loads + authenticates the captured journal/proof
//                               pair through the Task 3 store (models +
//                               keyProvider), then verifies the payment against
//                               an independently collected Task 4 chain session.
//                               A legacy journal row (no capture tuple) falls
//                               back to the legacy path: with the DEFAULT null
//                               surviving-proof provider it stays unresolved
//                               (LEGACY_PROOF_MISSING); an explicitly injected
//                               trusted provider may contribute the actual key
//                               bundle (held in process memory only).
//   verifyLegacyPaymentTransaction  verifies a legacy candidate from a CLOSED
//                               historical contract (frozen membership) plus the
//                               session; dispatchId/capture identity are never
//                               synthesized and no journal/proof row is written.
//
// Verification flow (CAPTURE_V1): prove scope and a compatible canonical
// boundary first; require a complete Task 4 session and call
// session.ownershipFor(txHash) for the exact hash so the input key-image gate
// actually runs; the raw fee must equal the captured fee exactly; every raw
// input must resolve to an independently restored owned prior output; the
// source-account set is derived and compared to the capture; recipients are
// classified by DECODED receiving keys (never caller-owned flags); external
// aggregates are grouped per receiving identity and checked ONCE per distinct
// address through the exact checkTxKey receipt gate (amount, not-in-pool,
// confirmations >= repository REQUIRED_CONFIRMATIONS, never the probe's
// hardcoded 10); the key-public structure gate binds the captured key bundle to
// the raw chain byte for byte; the owned target/change partition gate enforces
// the intended owned policy; only then is the closure D = O + F + E computed
// with a signed canonical residual. There is no cached-destination fallback and
// no caller-supplied verified flag anywhere in this module.
//
// Safe results only: PaymentVerificationV1 carries amounts as strings, fixed
// uppercase issue codes and provenance digests — never key images, stealth
// keys, envelope bytes, nonces, ciphertext, key material or SDK objects. Chain
// evidence failures surface as their fixed codes; error MESSAGE text (which
// carries hashes and key images) is never copied into a result.

const VERIFICATION_VERSION = '1'
const VERIFIER_VERSION = '1'
const SDK_VERSION = '0.11.12'
const PROVENANCE = 'restored-owned-outputs/raw-chain/check-tx-key'
const SURVIVING_DIGEST_DOMAIN = 'stashernews/monero/surviving-evidence/v1\0'
const APPLICATION = 'stashernews/monero/payment'

const HEX64 = /^[0-9a-f]{64}$/
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/
const CANONICAL_SIGNED = /^-?(0|[1-9][0-9]*)$/
const ISSUE_CODE = /^[A-Z][A-Z0-9_]*$/
const ADDRESS_TYPES = new Set(['PRIMARY', 'INTEGRATED', 'SUBADDRESS'])
const NETWORKS = new Set(['MAINNET', 'STAGENET'])
const JOURNAL_MODELS = { REWARDS: 'rewardsWalletTransaction', ESCROW: 'escrowWalletTransaction' }
const EVIDENCE_ERROR_NAME = 'PaymentChainEvidenceError'
const LEGACY_PARTITION_KINDS = new Set(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION', 'AWARD', 'RECLAIM', 'ROLLOVER', 'LEGACY_SEPARATE_FEE'])

// The three declared safe-refusal boundaries and the single informational
// (non-material) issue. Every other issue is material.
const BOUNDARY_ISSUES = new Set([
  'MIXED_SOURCE_UNSUPPORTED',
  'OWNED_CHANGE_SPLIT_UNSUPPORTED',
  'PAYMENT_ID_UNSUPPORTED'
])
const INFORMATIONAL_ISSUES = new Set(['LEGACY_RECORDED_FEE_MISMATCH'])

const RESULT_FIELDS = Object.freeze([
  'verificationVersion', 'status', 'issues', 'scope', 'journalRole', 'journalId',
  'dispatchId', 'captureMode', 'txHash', 'claimDigest', 'proofInventory',
  'sourceAccounts', 'members', 'receivingAggregates', 'ownedAccounting',
  'totals', 'confirmation', 'observedAt', 'boundary', 'verifierVersion',
  'sdkVersion', 'provenance', 'survivingEvidenceDigest'
])
const PROOF_INVENTORY_FIELDS = Object.freeze([
  'proofId', 'revision', 'masterKeyVersion', 'bindingVersion', 'envelopeVersion',
  'payloadVersion', 'claimDigest', 'bindingDigest', 'envelopeIntegrityDigest'
])
const MEMBER_FIELDS = Object.freeze([
  'id', 'leg', 'address', 'type', 'paymentId', 'receivingIdentity',
  'grossPiconeros', 'actualPiconeros'
])
const LEGACY_CONTRACT_FIELDS = Object.freeze([
  'scope', 'txHash', 'journalRole', 'journalId', 'owner', 'members',
  'recordedFeePiconeros'
])
const LEGACY_OWNER_FIELDS = Object.freeze(['kind', 'distributionId', 'bountyPaymentId', 'itemId'])
const SURVIVING_FIELDS = Object.freeze(['keyBundleHex', 'source', 'provenanceId'])

const failRequest = detail => {
  throw new Error(`PAYMENT_VERIFICATION_REQUEST_INVALID: ${detail}`)
}

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const canonicalAmount = value => {
  if (typeof value === 'bigint') return value < 0n ? null : value.toString()
  if (typeof value === 'string' && CANONICAL_UNSIGNED.test(value)) return value
  return null
}

const canonicalIso = value => {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString()
}

const isSafeNonNegativeInt = value => Number.isSafeInteger(value) && value >= 0
const isHex64 = value => typeof value === 'string' && HEX64.test(value)

const sortedUnique = values => [...new Set(values)].sort()

/**
 * Normalize a verifier request: observedAt as canonical ISO, complete session
 * shape. The session is the private Task 4 evidence object (real collector
 * output, optionally extended with the captured wallet's `checkTxKey` receipt
 * checker). The Task 1 canned stand-in (plain-object rawByHash, prior rows
 * directly in inputSources) is accepted by the same adapter.
 */
function prepareSession (session, observedAt) {
  if (!isPlainObject(session) || typeof session.ownershipFor !== 'function' ||
    !isPlainObject(session.rawByHash) || !Array.isArray(session.ownedOutputs)) {
    failRequest('a complete Task 4 chain session is required')
  }
  const iso = canonicalIso(observedAt)
  if (iso === null) failRequest('observedAt must be an ISO timestamp')
  return { session, observedAt: iso }
}

// --- session adapter (real Task 4 session and Task 1 canned stand-in) --------

function sessionRawFor (session, txHash) {
  const rawByHash = session.rawByHash
  if (rawByHash === null || typeof rawByHash !== 'object') return null
  if (typeof rawByHash.get === 'function') return rawByHash.get(txHash) ?? null
  return Object.prototype.hasOwnProperty.call(rawByHash, txHash) ? rawByHash[txHash] : null
}

/**
 * ownershipFor(session, txHash) — calls the session's own resolver so the
 * collector's input key-image gate actually runs, then normalizes the two
 * supported session shapes into { raw, owned, inputSources: [{keyImage,
 * prior, priorRaw}] }. Evidence refusals (missing key image, missing prior
 * raw, scan disagreement) propagate as their fixed codes.
 */
function resolveOwnership (session, txHash) {
  const ownership = session.ownershipFor(txHash)
  const raw = ownership !== null && ownership !== undefined && ownership.raw !== undefined
    ? ownership.raw
    : sessionRawFor(session, txHash)
  const owned = ownership !== null && ownership !== undefined && Array.isArray(ownership.owned)
    ? ownership.owned
    : []
  const inputSourceEntries = ownership !== null && ownership !== undefined && Array.isArray(ownership.inputSources)
    ? ownership.inputSources
    : []
  const inputSources = inputSourceEntries.map(entry => {
    const prior = isPlainObject(entry) && entry.prior !== undefined ? entry.prior : entry
    const priorRaw = isPlainObject(entry) && entry.priorRaw !== undefined
      ? entry.priorRaw
      : sessionRawFor(session, prior?.txHash)
    return {
      keyImage: isPlainObject(entry) ? entry.keyImage ?? null : null,
      prior,
      priorRaw
    }
  })
  return { raw, owned, inputSources }
}

// --- chain facts --------------------------------------------------------------

/**
 * The raw chain's transaction public keys: from the strict ordered extra
 * parser when the daemon shape carries `extra`, else from the canonical
 * fixture-shape fields. Returns null when neither source exists.
 */
function rawTxKeysFor (raw) {
  if (typeof raw.extra === 'string') {
    const parsed = parseTxExtraStrict(raw.extra)
    return { main: parsed.main, additional: [...parsed.additional] }
  }
  const main = isHex64(raw.mainPublicKey) ? raw.mainPublicKey : null
  if (main === null) return null
  const additional = Array.isArray(raw.additionalPublicKeys) &&
    raw.additionalPublicKeys.every(key => isHex64(key))
    ? [...raw.additionalPublicKeys]
    : []
  return { main, additional }
}

const impliedTipOf = raw => {
  if (!isSafeNonNegativeInt(raw?.blockHeight)) return null
  if (!isSafeNonNegativeInt(raw?.confirmations) || raw.confirmations < 1) return null
  return raw.blockHeight + raw.confirmations - 1
}

/**
 * Canonical boundary facts for the audited closure: every raw record carrying
 * confirmation data must imply the SAME collection tip.
 */
function canonicalBoundary ({ auditedRaw, priorRaws }) {
  const tips = new Set()
  for (const raw of [auditedRaw, ...priorRaws]) {
    const tip = impliedTipOf(raw)
    if (tip !== null) tips.add(tip)
  }
  if (tips.size > 1) return { ok: false, boundary: { height: null, blockHash: null } }
  const height = tips.size === 1 ? [...tips][0] : null
  return { ok: true, boundary: { height, blockHash: null } }
}

// --- issue bookkeeping ----------------------------------------------------------

function newIssues () {
  const issues = {
    boundary: [],
    material: [],
    unresolved: [],
    informational: [],
    status () {
      if (issues.boundary.length > 0) return 'unsupported'
      if (issues.material.length > 0) return 'rejected'
      if (issues.unresolved.length > 0) return 'unresolved'
      return 'complete'
    },
    sorted () {
      return sortedUnique([...issues.boundary, ...issues.material, ...issues.informational, ...issues.unresolved])
    }
  }
  return issues
}

const addMaterial = (issues, code) => { issues.material.push(code) }
const addBoundary = (issues, code) => { issues.boundary.push(code) }
const addUnresolved = (issues, code) => { issues.unresolved.push(code) }
const addInformational = (issues, code) => { issues.informational.push(code) }

// --- recipient classification (decoded receiving keys, never caller flags) -----

/**
 * Decode every contracted member address, verify the decoded receiving keys
 * against the claimed identity/type/payment-id, recompute the identity
 * aggregates and compare them with the claimed aggregates. Returns one entry
 * per distinct (receivingIdentity, address) pair — the unit the exact
 * checkTxKey gate runs ONCE for.
 */
function classifyRecipients ({ members, network, claimedAggregates, issues }) {
  const addressGroups = new Map()
  const identityTotals = new Map()
  let paymentIdClaimed = false
  for (const member of members) {
    let decoded
    try {
      decoded = decodeReceivingIdentity(member.address, network)
    } catch {
      addMaterial(issues, 'AGGREGATE_MISMATCH')
      return { ok: false }
    }
    if (decoded.identity !== member.receivingIdentity ||
      decoded.type !== member.type ||
      (decoded.paymentId ?? null) !== (member.paymentId ?? null)) {
      addMaterial(issues, 'AGGREGATE_MISMATCH')
      return { ok: false }
    }
    if (member.paymentId !== null) paymentIdClaimed = true
    const actual = BigInt(member.actualPiconeros)
    const groupKey = `${decoded.identity}|${member.address}`
    const group = addressGroups.get(groupKey) ?? {
      receivingIdentity: decoded.identity,
      address: member.address,
      expected: 0n,
      confirmed: null
    }
    group.expected += actual
    addressGroups.set(groupKey, group)
    identityTotals.set(decoded.identity, (identityTotals.get(decoded.identity) ?? 0n) + actual)
  }
  const claimed = new Map(claimedAggregates.map(aggregate =>
    [aggregate.receivingIdentity, BigInt(aggregate.amountPiconeros)]))
  if (claimed.size !== identityTotals.size) {
    addMaterial(issues, 'AGGREGATE_MISMATCH')
    return { ok: false }
  }
  for (const [identity, total] of identityTotals) {
    if (claimed.get(identity) !== total) {
      addMaterial(issues, 'AGGREGATE_MISMATCH')
      return { ok: false }
    }
  }
  return { ok: true, addressGroups: [...addressGroups.values()], paymentIdClaimed }
}

// --- exact receipt gate ---------------------------------------------------------

const readReceiptAmount = value => {
  if (typeof value === 'bigint') return value < 0n ? null : value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && CANONICAL_UNSIGNED.test(value)) return BigInt(value)
  return null
}

/**
 * Check each distinct address of each receiving identity exactly once via the
 * exact checkTxKey gate: not in the pool, confirmations at or above the
 * repository REQUIRED_CONFIRMATIONS, isGood with the exact expected amount.
 * Boolean isGood is NOT receipt evidence by itself; wrong or zero amounts
 * refuse as a conflicting observation (RECEIPT_AMOUNT_MISMATCH); absence stays
 * unresolved (RECEIPT_UNAVAILABLE / CONFIRMATION_REQUIRED). Returns whether
 * EVERY group verified — only then is E computable.
 */
async function verifyReceipts ({ checker, txHash, keyBundleHex, addressGroups, issues }) {
  let complete = true
  for (const group of addressGroups) {
    let result = null
    try {
      result = await checker(txHash, keyBundleHex, group.address)
    } catch {
      result = null
    }
    if (!isPlainObject(result)) {
      addUnresolved(issues, 'RECEIPT_UNAVAILABLE')
      complete = false
      continue
    }
    const inPool = typeof result.getInTxPool === 'function' && result.getInTxPool() === true
    const confirmations = typeof result.getNumConfirmations === 'function'
      ? result.getNumConfirmations()
      : null
    const isGood = typeof result.getIsGood === 'function' ? result.getIsGood() === true : false
    const received = typeof result.getReceivedAmount === 'function'
      ? readReceiptAmount(result.getReceivedAmount())
      : null
    if (inPool || !isSafeNonNegativeInt(confirmations) || confirmations < REQUIRED_CONFIRMATIONS) {
      addUnresolved(issues, 'CONFIRMATION_REQUIRED')
      complete = false
      continue
    }
    if (!isGood || received === null) {
      addUnresolved(issues, 'RECEIPT_UNAVAILABLE')
      complete = false
      continue
    }
    if (received !== group.expected) {
      addMaterial(issues, 'RECEIPT_AMOUNT_MISMATCH')
      complete = false
      continue
    }
    group.confirmed = confirmations
  }
  return { complete }
}

// --- key-public structure gate --------------------------------------------------

function dedupeRecipients (members, network, excludedIdentities) {
  const seen = new Map()
  for (const member of members) {
    let decoded
    try {
      decoded = decodeReceivingIdentity(member.address, network)
    } catch {
      continue
    }
    if (excludedIdentities.has(decoded.identity)) continue
    seen.set(decoded.identity, {
      viewKey: decoded.viewKey,
      spendKey: decoded.spendKey,
      subaddress: decoded.type === 'SUBADDRESS'
    })
  }
  return [...seen.values()]
}

/**
 * Bind the captured/surviving key bundle to the raw chain's transaction public
 * keys. The bundle MUST parse as the secret-scalar bundle (main secret + the
 * advertised additional secrets) — public-point bundles are no longer a
 * compatibility path (final-review I1). Correspondence is enforced ONLY
 * through the kind-aware per-output rules over the sender's secrets and the
 * recipients' PUBLIC keys: r_i*B for subaddress additional keys, r_i*G for
 * standard/change slots, and the a*R owned path — with scan-owned local
 * output indexes exempt (their ownership is independently proven by the
 * scan). Populated built public facts must still equal the raw keys byte for
 * byte when present. Any unclassifiable output refuses.
 */
function assertKeyStructure ({ keyBundleHex, additionalKeyCount, builtStructure, raw, recipients, ownedIndexes, issues }) {
  if (!isPlainObject(raw)) return
  let keys
  try {
    keys = rawTxKeysFor(raw)
  } catch {
    addMaterial(issues, 'KEY_STRUCTURE_MISMATCH')
    return
  }
  if (keys === null) {
    addUnresolved(issues, 'KEY_STRUCTURE_UNAVAILABLE')
    return
  }

  // The secret-scalar bundle is REQUIRED (final-review I1). A missing explicit
  // count (legacy surviving material) is derived from the raw chain's ordered
  // additional keys so multi-secret bundles stay on the deep path.
  let bundle = null
  try {
    bundle = parseKeyBundleHex(keyBundleHex, additionalKeyCount ?? keys.additional.length)
  } catch {
    bundle = null
  }
  if (bundle === null) {
    addMaterial(issues, 'KEY_STRUCTURE_MISMATCH')
    return
  }

  if (builtStructure.mainPublicKey !== null && builtStructure.mainPublicKey !== undefined &&
    builtStructure.mainPublicKey !== keys.main) {
    addMaterial(issues, 'KEY_STRUCTURE_MISMATCH')
  }
  if (Array.isArray(builtStructure.additionalPublicKeys) &&
    builtStructure.additionalPublicKeys.join('') !== keys.additional.join('')) {
    addMaterial(issues, 'KEY_STRUCTURE_MISMATCH')
  }
  if (Array.isArray(builtStructure.outputKeys) &&
    (builtStructure.outputKeys.length !== raw.voutKeys.length ||
      builtStructure.outputKeys.some((key, index) => key !== raw.voutKeys[index]))) {
    addMaterial(issues, 'KEY_STRUCTURE_MISMATCH')
  }

  const owned = ownedIndexes instanceof Set ? ownedIndexes : new Set()
  let classifications
  try {
    classifications = classifyOutputKeys({
      bundle,
      txExtraKeys: keys,
      outputKeys: raw.voutKeys,
      recipients,
      owned: []
    })
  } catch (err) {
    if (err?.name === 'PaymentKeyStructureError') {
      addMaterial(issues, 'KEY_PUBLIC_STRUCTURE_UNSUPPORTED')
      return
    }
    throw err
  }
  for (const row of classifications) {
    // Scan-owned outputs carry independent derivation proof of ownership —
    // a null sender-side association for them is expected, not a refusal.
    if (row.association === null && !owned.has(row.outputIndex)) {
      addMaterial(issues, 'KEY_PUBLIC_STRUCTURE_UNSUPPORTED')
    }
  }
}

// --- closure facts from the session ------------------------------------------------

/**
 * Independently derived closure facts for one audited transaction: D from the
 * resolved input priors, O from the scan-owned outputs, F from the raw fee,
 * plus the source-account set and the owned-row partition against the captured
 * change/owned-target positions. `capturedFeePiconeros` is null on the legacy
 * path (no authenticated capture to compare against).
 *
 * Boundary/maturity discipline (final-review I4): the SESSION's authoritative
 * collection boundary is retained when supplied — never discarded — and
 * maturity is derived from independently checked heights (audited block
 * height against the boundary height, repository REQUIRED_CONFIRMATIONS).
 * The necessary block facts (height AND daemon-resolved block hash) are
 * required; missing audited confirmation data can never produce `complete`.
 * Raw records that DO carry confirmation counts are still cross-checked for
 * tip coherence (a moving collection is BOUNDARY_INCONSISTENT).
 */
function closureFacts ({ ownership, txHash, claims, capturedFeePiconeros, builtStructure, skipSourceCheck, partitionRequired, legacyKind, session, issues }) {
  const raw = ownership.raw
  if (!isPlainObject(raw)) {
    addUnresolved(issues, 'RAW_TX_MISSING')
    return null
  }
  if (raw.txHash !== txHash) {
    addMaterial(issues, 'HASH_MISMATCH')
    return null
  }
  if (raw.inTxPool === true) {
    addUnresolved(issues, 'CONFIRMATION_REQUIRED')
    return null
  }
  const auditedFee = typeof raw.feePiconeros === 'bigint' && raw.feePiconeros >= 0n ? raw.feePiconeros : null
  if (auditedFee === null) {
    addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
    return null
  }
  if (capturedFeePiconeros !== null && auditedFee !== capturedFeePiconeros) {
    addMaterial(issues, 'FEE_MISMATCH')
  }

  // D side: every input must resolve to an independently restored owned prior
  // whose own raw record is present.
  let D = 0n
  const priorRaws = []
  const sourceAccounts = new Set()
  for (const source of ownership.inputSources) {
    const prior = source.prior
    if (!isPlainObject(prior) || typeof prior.amountPiconeros !== 'bigint' || prior.amountPiconeros < 0n ||
      !isSafeNonNegativeInt(prior.accountIndex)) {
      addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
      return null
    }
    if (!isPlainObject(source.priorRaw)) {
      addUnresolved(issues, 'PRIOR_TX_MISSING')
      return null
    }
    D += prior.amountPiconeros
    sourceAccounts.add(String(prior.accountIndex))
    priorRaws.push(source.priorRaw)
  }

  const boundaryCheck = canonicalBoundary({ auditedRaw: raw, priorRaws })
  if (!boundaryCheck.ok) addUnresolved(issues, 'BOUNDARY_INCONSISTENT')
  if (session?.scope?.network !== claims.scope.network || session?.scope?.walletAddress !== claims.scope.walletAddress) {
    addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
  }
  if (session?.journalRole != null && claims.journalRole != null && session.journalRole !== claims.journalRole) {
    addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
  }
  // The authoritative session boundary wins when supplied; a derived tip that
  // disagrees with it is incoherent collection evidence.
  const suppliedBoundary = isPlainObject(session) ? session.boundary : null
  const authoritativeBoundary = suppliedBoundary !== null && suppliedBoundary !== undefined &&
    isSafeNonNegativeInt(suppliedBoundary.height) && isHex64(suppliedBoundary.blockHash)
    ? { height: suppliedBoundary.height, blockHash: suppliedBoundary.blockHash }
    : { height: null, blockHash: null }
  if (authoritativeBoundary.height === null) addUnresolved(issues, 'BOUNDARY_INCONSISTENT')
  if (authoritativeBoundary.height !== null && boundaryCheck.boundary.height !== null &&
    authoritativeBoundary.height !== boundaryCheck.boundary.height) {
    addUnresolved(issues, 'BOUNDARY_INCONSISTENT')
  }

  // O side: the scan-owned outputs of the audited transaction, partitioned
  // against the captured change/owned-target positions — with the session's
  // independent position↔address mapping applied to the captured facts when
  // the session can supply it (final-review I6).
  let O = 0n
  const ownedOutputs = []
  const positions = new Map()
  const positionSums = new Map()
  const addPosition = (accountIndex, subaddressIndex, address) => {
    const key = `${accountIndex}:${subaddressIndex}`
    if (!positions.has(key)) positions.set(key, { accountIndex, subaddressIndex, address })
  }
  if (claims.change !== null && claims.change !== undefined) {
    addPosition(
      Number(claims.change.accountIndex),
      Number(claims.change.subaddressIndex),
      claims.change.address
    )
  }
  for (const target of claims.ownedTargets ?? []) {
    addPosition(Number(target.accountIndex), Number(target.subaddressIndex), target.address)
  }
  // Legacy facts remain uncaptured: derive the permitted position from the
  // independently owned inputs and repository source-primary/change policy.
  // A consolidation must move its whole internal amount to the scope primary.
  let legacyTarget = null
  if (skipSourceCheck) {
    const mapper = addressForPositionOf(session)
    if (!LEGACY_PARTITION_KINDS.has(legacyKind) || sourceAccounts.size !== 1 || mapper === null) {
      addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
    } else {
      const major = legacyKind === 'CONSOLIDATION' ? 0 : Number([...sourceAccounts][0])
      const address = mapper(major, 0)
      if (typeof address !== 'string' || (legacyKind === 'CONSOLIDATION' && address !== claims.scope.walletAddress)) {
        addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
      } else {
        addPosition(major, 0, address)
        if (legacyKind === 'CONSOLIDATION') legacyTarget = `${major}:0`
      }
    }
  }
  // Authenticated REWARDS/PAYOUT captures may legitimately carry UNKNOWN change:
  // the pinned SDK leaves getChangeAddress/getChangeAmount unset while the
  // chain still has a valid change output. Captured facts stay null; permit
  // ONLY the independently derived source-primary (minor 0) position supplied
  // by the session's prepared position/address map. This is a derived policy,
  // never an observed amount: the raw ownership enumeration and the mandatory
  // D−O−F−E closure still constrain the outputs. Missing mapping or evidence,
  // a source-set mismatch, or any non-primary owned output remains refused.
  // Explicitly captured change keeps its stricter existing checks below.
  let unknownChangePolicyUnresolved = false
  if (!skipSourceCheck && partitionRequired && claims.journalRole === 'REWARDS' &&
    claims.kind === 'PAYOUT' && claims.change === null &&
    (builtStructure?.changeAddress ?? null) === null &&
    (builtStructure?.changeAmountPiconeros ?? null) === null) {
    const derivedSources = sortedUnique([...sourceAccounts])
    const capturedSources = sortedUnique((claims.sourceAccounts ?? []).map(account => String(account)))
    const mapper = addressForPositionOf(session)
    const major = derivedSources.length === 1 ? Number(derivedSources[0]) : null
    const prepared = major !== null && isSafeNonNegativeInt(major) && Array.isArray(session?.derivedPositions)
      ? session.derivedPositions.find(entry => isPlainObject(entry) &&
        entry.majorIndex === major && entry.minorIndex === 0)
      : null
    const address = prepared ? mapper?.(major, 0) : null
    if (derivedSources.length !== 1 || capturedSources.length !== 1 ||
      capturedSources[0] !== derivedSources[0] || mapper === null ||
      !isPlainObject(prepared) || typeof address !== 'string' || address === '' ||
      prepared.address !== address) {
      unknownChangePolicyUnresolved = true
      addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
    } else {
      addPosition(major, 0, address)
    }
  }
  for (const captured of positions.values()) {
    const mapper = addressForPositionOf(session)
    const derivedAddress = mapper?.(captured.accountIndex, captured.subaddressIndex)
    if (typeof derivedAddress !== 'string') {
      addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
    } else if (derivedAddress !== captured.address) {
      addMaterial(issues, 'OWNED_PARTITION_MISMATCH')
    }
  }
  for (const row of ownership.owned) {
    if (typeof row.amountPiconeros !== 'bigint' || row.amountPiconeros < 0n ||
      !isSafeNonNegativeInt(row.accountIndex) || !isSafeNonNegativeInt(row.subaddressIndex)) {
      addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
      return null
    }
    const position = `${row.accountIndex}:${row.subaddressIndex}`
    if (partitionRequired && !positions.has(position)) {
      // Unestablished legacy / unknown-change policy is unresolved, not
      // fabricated capture: without a prepare-domain map there is no basis to
      // call an independently scanned owned output wrong. A source-set or
      // explicit-capture mismatch is handled by its own material gate.
      if ((skipSourceCheck || unknownChangePolicyUnresolved) && positions.size === 0) {
        addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
      } else {
        addMaterial(issues, 'OWNED_PARTITION_MISMATCH')
      }
    }
    positionSums.set(position, (positionSums.get(position) ?? 0n) + row.amountPiconeros)
    O += row.amountPiconeros
    ownedOutputs.push({
      outputIndex: isSafeNonNegativeInt(row.outputIndex) ? row.outputIndex : null,
      accountIndex: row.accountIndex,
      subaddressIndex: row.subaddressIndex,
      amountPiconeros: row.amountPiconeros.toString(),
      isSpent: row.isSpent === true
    })
  }
  if (partitionRequired) {
    if (claims.change != null && builtStructure?.changeAmountPiconeros != null) {
      const position = `${claims.change.accountIndex}:${claims.change.subaddressIndex}`
      if ((positionSums.get(position) ?? 0n) !== BigInt(builtStructure.changeAmountPiconeros)) {
        addMaterial(issues, 'OWNED_PARTITION_MISMATCH')
      }
    }
    if (legacyTarget !== null && (positionSums.get(legacyTarget) ?? 0n) !== D - auditedFee) {
      addMaterial(issues, 'OWNED_PARTITION_MISMATCH')
    }
    for (const target of claims.ownedTargets ?? []) {
      if (target.amountPiconeros === null || target.amountPiconeros === undefined) continue
      const position = `${target.accountIndex}:${target.subaddressIndex}`
      if ((positionSums.get(position) ?? 0n) !== BigInt(target.amountPiconeros)) {
        addMaterial(issues, 'OWNED_PARTITION_MISMATCH')
      }
    }
  }
  ownedOutputs.sort((a, b) =>
    (a.accountIndex - b.accountIndex) || (a.subaddressIndex - b.subaddressIndex) ||
    ((a.outputIndex ?? 0) - (b.outputIndex ?? 0)))

  // Source-account set: exactly one captured account; several cannot be
  // attributed and are the declared safe refusal.
  const derivedSources = sortedUnique([...sourceAccounts])
  if (derivedSources.length > 1) {
    addBoundary(issues, 'MIXED_SOURCE_UNSUPPORTED')
  } else if (!skipSourceCheck) {
    const claimedSources = sortedUnique((claims.sourceAccounts ?? []).map(account => String(account)))
    if (JSON.stringify(derivedSources) !== JSON.stringify(claimedSources)) {
      addMaterial(issues, 'SOURCE_ACCOUNT_MISMATCH')
    }
  }

  // Required block facts (final-review I4): the audited height and its
  // daemon-resolved block hash must both be present, and maturity is DERIVED
  // from the independently checked heights — never taken from a volatile or
  // optional raw confirmation count.
  const auditedHeight = isSafeNonNegativeInt(raw.blockHeight) ? raw.blockHeight : null
  const auditedBlockHash = isHex64(raw.blockHash) ? raw.blockHash : null
  if (auditedHeight === null || auditedBlockHash === null) {
    addUnresolved(issues, 'CHAIN_EVIDENCE_INCOMPLETE')
  }
  let auditedConfirmations = null
  if (auditedHeight !== null && authoritativeBoundary.height !== null &&
    auditedHeight <= authoritativeBoundary.height) {
    auditedConfirmations = authoritativeBoundary.height - auditedHeight + 1
  }
  if (auditedConfirmations === null) addUnresolved(issues, 'CONFIRMATION_REQUIRED')

  return {
    D,
    O,
    F: auditedFee,
    ownedOutputs,
    derivedSources,
    auditedConfirmations,
    boundary: authoritativeBoundary,
    auditedHeight,
    auditedBlockHash
  }
}

// The session's independent position→address mapper (final-review I6), read
// defensively from whichever session shape supplies it.
const addressForPositionOf = sessionLike => {
  if (isPlainObject(sessionLike) && typeof sessionLike.addressForPosition === 'function') {
    return sessionLike.addressForPosition
  }
  return null
}

// --- shared verification core (capture and legacy run the same gates) --------------

/**
 * Run the independent gates shared by both paths against one session.
 * `claimsLike` carries the closed per-payment expectations: txHash, scope,
 * networkFeePiconeros (null on the legacy path), sourceAccounts, change,
 * ownedTargets, members, receivingAggregates. `ownedIdentities` are the
 * wallet-owned receiving identities (captured change/owned-target identities;
 * on the legacy path the scope wallet identity) — a contracted recipient
 * sharing one of them is the declared owned-split refusal.
 */
async function runGates ({
  claimsLike,
  session,
  keyBundleHex,
  additionalKeyCount,
  builtStructure,
  capturedFeePiconeros,
  skipSourceCheck,
  partitionRequired,
  legacyKind = null,
  ownedIdentities: ownedIdentitiesBase
}) {
  const issues = newIssues()
  // The owned identity set is the COMPLETE derived wallet identity set
  // (final-review I6) — every position the session's prepared domain carries,
  // plus the captured change/owned-target identities — not only the
  // identities a capture happened to name.
  const ownedIdentities = new Set(ownedIdentitiesBase)
  for (const entry of Array.isArray(session?.derivedPositions) ? session.derivedPositions : []) {
    if (isPlainObject(entry) && typeof entry.address === 'string') {
      try {
        ownedIdentities.add(decodeReceivingIdentity(entry.address, claimsLike.scope.network).identity)
      } catch { /* the prepared domain was already validated upstream */ }
    }
  }
  const members = claimsLike.members.map(member => ({
    id: String(member.id),
    leg: member.leg ?? 'PRINCIPAL',
    address: member.address,
    type: member.type,
    paymentId: member.paymentId ?? null,
    receivingIdentity: member.receivingIdentity,
    grossPiconeros: canonicalAmount(member.grossPiconeros ?? member.actualPiconeros),
    actualPiconeros: canonicalAmount(member.actualPiconeros)
  }))

  let ownership = null
  try {
    ownership = resolveOwnership(session, claimsLike.txHash)
  } catch (err) {
    if (err?.name !== EVIDENCE_ERROR_NAME) throw err
    addUnresolved(issues, err.code)
  }

  let facts = null
  if (ownership !== null) {
    facts = closureFacts({
      ownership,
      txHash: claimsLike.txHash,
      claims: claimsLike,
      capturedFeePiconeros,
      builtStructure,
      skipSourceCheck,
      partitionRequired,
      legacyKind,
      session,
      issues
    })
  }

  let E = null
  const receivingAggregates = []
  if (facts !== null) {
    const classification = classifyRecipients({
      members: claimsLike.members,
      network: claimsLike.scope.network,
      claimedAggregates: claimsLike.receivingAggregates,
      issues
    })
    if (classification.ok) {
      let ownedSplit = false
      for (const member of claimsLike.members) {
        const decoded = decodeReceivingIdentity(member.address, claimsLike.scope.network)
        if (ownedIdentities.has(decoded.identity)) ownedSplit = true
      }
      if (ownedSplit) addBoundary(issues, 'OWNED_CHANGE_SPLIT_UNSUPPORTED')
      if (classification.paymentIdClaimed) addBoundary(issues, 'PAYMENT_ID_UNSUPPORTED')

      // Receipts run once per distinct address unless attribution itself is
      // refused (mixed source / owned split). The payment-ID boundary does not
      // block amount handling: amount/alias handling works, the claim does not.
      const attributionRefused = ownedSplit || issues.boundary.includes('MIXED_SOURCE_UNSUPPORTED')
      const checker = typeof session.checkTxKey === 'function' ? session.checkTxKey : null
      if (attributionRefused) {
        // no receipts possible for refused attribution; E stays unknown
      } else if (checker === null) {
        addUnresolved(issues, 'RECEIPT_CHECK_UNAVAILABLE')
      } else {
        const { complete } = await verifyReceipts({
          checker,
          txHash: claimsLike.txHash,
          keyBundleHex,
          addressGroups: classification.addressGroups,
          issues
        })
        if (complete) {
          const byIdentity = new Map()
          for (const group of classification.addressGroups) {
            const entry = byIdentity.get(group.receivingIdentity) ?? {
              receivingIdentity: group.receivingIdentity,
              amountPiconeros: 0n,
              confirmations: null
            }
            entry.amountPiconeros += group.expected
            if (group.confirmed !== null) {
              entry.confirmations = entry.confirmations === null
                ? group.confirmed
                : Math.min(entry.confirmations, group.confirmed)
            }
            byIdentity.set(group.receivingIdentity, entry)
          }
          receivingAggregates.push(...[...byIdentity.values()]
            .map(entry => ({
              receivingIdentity: entry.receivingIdentity,
              amountPiconeros: entry.amountPiconeros.toString(),
              confirmations: entry.confirmations
            }))
            .sort((a, b) => (a.receivingIdentity < b.receivingIdentity ? -1 : 1)))
          E = [...byIdentity.values()].reduce((sum, entry) => sum + entry.amountPiconeros, 0n)
        }
      }
    }
  }

  // Key-public structure gate — also when the closure facts failed, as long as
  // the raw record is available to bind the bundle against. Scan-owned local
  // output indexes are exempt from the null-association refusal (their
  // ownership is independently proven by the scan).
  assertKeyStructure({
    keyBundleHex,
    additionalKeyCount,
    builtStructure,
    raw: ownership?.raw ?? null,
    recipients: dedupeRecipients(claimsLike.members, claimsLike.scope.network, ownedIdentities),
    ownedIndexes: new Set((ownership?.owned ?? [])
      .filter(row => isSafeNonNegativeInt(row?.outputIndex))
      .map(row => row.outputIndex)),
    issues
  })

  const totals = facts === null || E === null
    ? { D: facts?.D?.toString() ?? null, O: facts?.O?.toString() ?? null, F: facts?.F?.toString() ?? null, E: null, residual: null }
    : (() => {
        const residual = facts.D - facts.O - facts.F - E
        return {
          D: facts.D.toString(),
          O: facts.O.toString(),
          F: facts.F.toString(),
          E: E.toString(),
          residual: residual.toString()
        }
      })()
  if (totals.residual !== null && totals.residual !== '0') {
    addMaterial(issues, 'UNCLAIMED_EXTERNAL_RESIDUAL')
  }
  if (facts?.auditedConfirmations != null && facts.auditedConfirmations < REQUIRED_CONFIRMATIONS) {
    addUnresolved(issues, 'CONFIRMATION_REQUIRED')
  }

  return {
    issues,
    totals,
    members,
    receivingAggregates,
    sourceAccounts: facts?.derivedSources ?? [],
    ownedAccounting: {
      totalPiconeros: facts === null ? null : facts.O.toString(),
      outputs: facts?.ownedOutputs ?? []
    },
    confirmation: {
      height: facts?.auditedHeight ?? null,
      blockHash: facts?.auditedBlockHash ?? null,
      confirmations: facts?.auditedConfirmations ?? null
    },
    boundary: facts?.boundary ?? { height: null, blockHash: null }
  }
}

// --- result assembly --------------------------------------------------------------

function buildResult ({
  status,
  issues,
  scope,
  journalRole,
  journalId,
  dispatchId,
  captureMode,
  txHash,
  claimDigest,
  proofInventory,
  sourceAccounts,
  members,
  receivingAggregates,
  ownedAccounting,
  totals,
  confirmation,
  boundary,
  observedAt,
  survivingEvidenceDigest
}) {
  return {
    verificationVersion: VERIFICATION_VERSION,
    status,
    issues: sortedUnique(issues),
    scope: { network: scope.network, walletAddress: scope.walletAddress },
    journalRole: journalRole ?? null,
    journalId: journalId === null || journalId === undefined ? null : String(journalId),
    dispatchId: dispatchId ?? null,
    captureMode: captureMode ?? null,
    txHash,
    claimDigest: claimDigest ?? null,
    proofInventory: proofInventory ?? null,
    sourceAccounts,
    members,
    receivingAggregates,
    ownedAccounting,
    totals,
    confirmation,
    observedAt,
    boundary,
    verifierVersion: VERIFIER_VERSION,
    sdkVersion: SDK_VERSION,
    provenance: PROVENANCE,
    survivingEvidenceDigest: survivingEvidenceDigest ?? null
  }
}

// degraded fact sets for results whose verification could not proceed
const emptyAggregates = () => ({ sourceAccounts: [], members: [], receivingAggregates: [] })
const nullTotals = () => ({ D: null, O: null, F: null, E: null, residual: null })
const nullConfirmation = () => ({ height: null, blockHash: null, confirmations: null })
const nullBoundary = () => ({ height: null, blockHash: null })

function legacyUnavailableResult ({ scope, journalRole, journalId, txHash, issues, observedAt, captureUnavailable }) {
  return buildResult({
    status: issues.status(),
    issues: issues.sorted(),
    scope,
    journalRole,
    journalId,
    dispatchId: null,
    captureMode: captureUnavailable ? null : 'LEGACY_SURVIVING_PROOF',
    txHash,
    claimDigest: null,
    proofInventory: null,
    ...emptyAggregates(),
    ownedAccounting: { totalPiconeros: null, outputs: [] },
    totals: nullTotals(),
    confirmation: nullConfirmation(),
    boundary: nullBoundary(),
    observedAt,
    survivingEvidenceDigest: null
  })
}

// --- legacy contract helpers --------------------------------------------------------

/**
 * Closed historical contract for a legacy REWARDS journal row, built from the
 * row's own frozen membership columns (the pre-capture closed metadata union).
 * Returns null for roles/shapes this module does not derive (never guessed):
 * legacy escrow contracts stay unavailable rather than fabricated.
 */
function contractFromLegacyJournal (journal, journalRole) {
  if (journalRole !== 'REWARDS') return null
  const metadata = journal.metadata
  if (!isPlainObject(metadata)) return null
  const members = []
  if (journal.kind === 'PAYOUT' && Array.isArray(metadata.payouts)) {
    for (const payout of metadata.payouts) {
      if (!isPlainObject(payout) || typeof payout.recipientAddress !== 'string') return null
      const amount = canonicalAmount(payout.piconeros)
      if (amount === null) return null
      let decoded
      try {
        decoded = decodeReceivingIdentity(payout.recipientAddress, journal.network)
      } catch {
        return null
      }
      members.push({
        id: String(payout.payoutId),
        leg: 'PRINCIPAL',
        address: payout.recipientAddress,
        type: decoded.type,
        paymentId: decoded.paymentId,
        grossPiconeros: amount,
        actualPiconeros: amount
      })
    }
  } else if (journal.kind === 'OPS_SWEEP' && typeof metadata.destination === 'string') {
    const amount = canonicalAmount(journal.principalPiconeros)
    if (amount === null) return null
    let decoded
    try {
      decoded = decodeReceivingIdentity(metadata.destination, journal.network)
    } catch {
      return null
    }
    members.push({
      id: '1',
      leg: 'PRINCIPAL',
      address: metadata.destination,
      type: decoded.type,
      paymentId: decoded.paymentId,
      grossPiconeros: amount,
      actualPiconeros: amount
    })
  } else if (journal.kind !== 'CONSOLIDATION') {
    return null
  }
  return {
    scope: { network: journal.network, walletAddress: journal.walletAddress },
    txHash: journal.txHash,
    journalRole,
    journalId: journal.id,
    owner: {
      kind: typeof journal.kind === 'string' ? journal.kind : null,
      distributionId: journal.distributionId === null || journal.distributionId === undefined
        ? null
        : String(journal.distributionId),
      bountyPaymentId: null,
      itemId: null
    },
    members,
    // The legacy recorded fee is bookkeeping, not authenticated capture: it
    // may be missing or wrong and is checked against the independently
    // verified raw fee only.
    recordedFeePiconeros: journal.networkFeePiconeros === null || journal.networkFeePiconeros === undefined
      ? null
      : canonicalAmount(journal.networkFeePiconeros)
  }
}

function validateLegacyContract (contract) {
  if (!isPlainObject(contract) ||
    Object.keys(contract).sort().join(',') !== LEGACY_CONTRACT_FIELDS.slice().sort().join(',')) {
    failRequest('legacy contract must carry exactly scope/txHash/journalRole/journalId/owner/members/recordedFeePiconeros')
  }
  if (!isPlainObject(contract.scope) || !NETWORKS.has(contract.scope.network) ||
    typeof contract.scope.walletAddress !== 'string' || contract.scope.walletAddress === '') {
    failRequest('legacy contract scope must be { network, walletAddress }')
  }
  if (typeof contract.txHash !== 'string' || !HEX64.test(contract.txHash)) {
    failRequest('legacy contract txHash must be 64 lowercase hex characters')
  }
  if (contract.journalRole !== null && contract.journalRole !== 'REWARDS' && contract.journalRole !== 'ESCROW') {
    failRequest('legacy contract journalRole must be REWARDS, ESCROW or null')
  }
  const journalIdOk = contract.journalId === null || contract.journalId === undefined ||
    (typeof contract.journalId === 'number' && Number.isSafeInteger(contract.journalId) && contract.journalId >= 0) ||
    (typeof contract.journalId === 'string' && CANONICAL_UNSIGNED.test(contract.journalId)) ||
    (typeof contract.journalId === 'bigint' && contract.journalId >= 0n)
  if (!journalIdOk) failRequest('legacy contract journalId must be null or a canonical id')
  if (!isPlainObject(contract.owner) ||
    Object.keys(contract.owner).sort().join(',') !== LEGACY_OWNER_FIELDS.slice().sort().join(',')) {
    failRequest('legacy contract owner must carry exactly kind/distributionId/bountyPaymentId/itemId')
  }
  if (!Array.isArray(contract.members)) failRequest('legacy contract members must be an array')
  for (const member of contract.members) {
    if (!isPlainObject(member) ||
      !Object.keys(member).every(key => MEMBER_FIELDS.includes(key)) ||
      typeof member.address !== 'string' ||
      canonicalAmount(member.actualPiconeros) === null) {
      failRequest('legacy contract member shape is invalid')
    }
  }
  if (contract.recordedFeePiconeros !== null && contract.recordedFeePiconeros !== undefined &&
    canonicalAmount(contract.recordedFeePiconeros) === null) {
    failRequest('legacy contract recordedFeePiconeros must be null or a canonical amount')
  }
}

function survivingEvidenceDigestOf ({ contract, material }) {
  return createHash('sha256')
    .update(SURVIVING_DIGEST_DOMAIN)
    .update(canonicalPaymentJson({
      application: APPLICATION,
      network: contract.scope.network,
      walletAddress: contract.scope.walletAddress,
      txHash: contract.txHash,
      source: material.source,
      provenanceId: material.provenanceId,
      // Safe digest of the surviving material — never the material itself.
      keyBundleDigest: createHash('sha256').update(material.keyBundleHex, 'utf8').digest('hex')
    }))
    .digest('hex')
}

function deriveLegacyAggregates (members) {
  const totals = new Map()
  for (const member of members) {
    totals.set(member.receivingIdentity, (totals.get(member.receivingIdentity) ?? 0n) + BigInt(member.actualPiconeros))
  }
  return [...totals.entries()]
    .map(([receivingIdentity, amount]) => ({ receivingIdentity, amountPiconeros: amount.toString() }))
    .sort((a, b) => (a.receivingIdentity < b.receivingIdentity ? -1 : 1))
}

// --- locked exports ------------------------------------------------------------------

/**
 * Verify one confirmed whole payment from its captured journal/proof pair and
 * an independently collected Task 4 chain session. Returns a safe
 * PaymentVerificationV1 result — never secret material. A legacy journal row
 * (no capture tuple) falls back to the legacy path with the injected
 * surviving-proof provider (default: none → LEGACY_PROOF_MISSING unresolved).
 *
 * @param {{
 *   models: object,
 *   journalRole: 'REWARDS'|'ESCROW',
 *   journalId: number|string|bigint,
 *   session: object,
 *   keyProvider: object,
 *   observedAt: string,
 *   survivingProofProvider?: Function
 * }} request
 * @returns {Promise<object>} PaymentVerificationV1
 */
export async function verifyPaymentTransaction (request) {
  const { models, journalRole, journalId, keyProvider, survivingProofProvider } = request ?? {}
  if (!isPlainObject(models) || (journalRole !== 'REWARDS' && journalRole !== 'ESCROW')) {
    failRequest('models and a REWARDS/ESCROW journalRole are required')
  }
  const { session, observedAt } = prepareSession(request?.session, request?.observedAt)

  const journalModel = models[JOURNAL_MODELS[journalRole]]
  if (typeof journalModel?.findUnique !== 'function') {
    failRequest('the journal model is not reachable')
  }
  let id
  try {
    id = BigInt(journalId)
  } catch {
    failRequest('journalId must be an integer-like id')
  }
  if (id < 0n) failRequest('journalId must not be negative')
  const journal = await journalModel.findUnique({ where: { id } })
  if (!journal) {
    const error = new Error('PAYMENT_PROOF_NOT_PREPARED')
    error.name = 'PaymentVerificationError'
    throw error
  }

  // Legacy journal rows have no authenticated capture identity: the recorded
  // delivery stands and verification falls to the legacy path.
  const completeCapture = journal.dispatchId !== null && journal.captureContractVersion !== null &&
    journal.claimDigest !== null && journal.paymentClaims !== null && journal.proofId !== null
  if (!completeCapture) {
    const contract = contractFromLegacyJournal(journal, journalRole)
    if (contract === null) {
      const issues = newIssues()
      addUnresolved(issues, 'LEGACY_PROOF_MISSING')
      addUnresolved(issues, 'LEGACY_CONTRACT_UNAVAILABLE')
      return legacyUnavailableResult({
        scope: { network: journal.network, walletAddress: journal.walletAddress },
        journalRole,
        journalId: journal.id,
        txHash: journal.txHash,
        issues,
        observedAt,
        captureUnavailable: false
      })
    }
    return verifyLegacyPaymentTransaction({
      contract,
      session,
      survivingProofProvider: typeof survivingProofProvider === 'function' ? survivingProofProvider : null,
      observedAt
    })
  }

  // Load + authenticate the pair through the store (real crypto, real rows).
  let loaded
  try {
    loaded = await loadPaymentProof({ models, journalRole, journalId: id, keyProvider })
  } catch (err) {
    const code = typeof err?.message === 'string' ? err.message.split(':')[0] : ''
    if (code === 'TXPROOF_KEY_VERSION_MISSING' || code === 'TXPROOF_PROVIDER_INVALID' ||
      code === 'TXPROOF_REGISTRY_INVALID' || code === 'TXPROOF_REGISTRY_KEY_INVALID' ||
      code === 'TXPROOF_KEY_VERSION_INVALID') {
      // Lost keys: durable delivery stands, verification stays unresolved.
      const issues = newIssues()
      addUnresolved(issues, 'PROOF_KEY_UNAVAILABLE')
      return legacyUnavailableResult({
        scope: { network: journal.network, walletAddress: journal.walletAddress },
        journalRole,
        journalId: journal.id,
        txHash: journal.txHash,
        issues,
        observedAt,
        captureUnavailable: true
      })
    }
    if (code === 'TXPROOF_ENVELOPE_AUTH_FAILED' || code === 'TXPROOF_CLAIM_DIGEST_MISMATCH' ||
      code === 'TXPROOF_ENVELOPE_INVALID' || code === 'TXPROOF_PAYLOAD_INVALID' ||
      code === 'PAYMENT_PROOF_CAPTURE_MISMATCH' || code === 'LEGACY_PROOF_MISSING') {
      const issues = newIssues()
      addMaterial(issues, code === 'LEGACY_PROOF_MISSING' ? 'CAPTURE_CORRUPT' : 'CAPTURE_CORRUPT')
      return legacyUnavailableResult({
        scope: { network: journal.network, walletAddress: journal.walletAddress },
        journalRole,
        journalId: journal.id,
        txHash: journal.txHash,
        issues,
        observedAt,
        captureUnavailable: true
      })
    }
    throw err
  }

  const { claims, payload, inventory } = loaded
  const issues = newIssues()
  // Scope coherence between the authenticated capture and the journal row.
  if (claims.scope.network !== journal.network || claims.scope.walletAddress !== journal.walletAddress ||
    claims.txHash !== journal.txHash) {
    addMaterial(issues, 'SCOPE_MISMATCH')
  }

  const ownedIdentities = new Set()
  if (claims.change !== null && claims.change.address !== null) {
    ownedIdentities.add(decodeReceivingIdentity(claims.change.address, claims.scope.network).identity)
  }
  for (const target of claims.ownedTargets) {
    if (target.address !== null) {
      ownedIdentities.add(decodeReceivingIdentity(target.address, claims.scope.network).identity)
    }
  }

  const gates = await runGates({
    claimsLike: claims,
    session,
    keyBundleHex: payload.keyBundleHex,
    additionalKeyCount: payload.additionalKeyCount,
    builtStructure: payload.builtStructure,
    capturedFeePiconeros: BigInt(claims.networkFeePiconeros),
    skipSourceCheck: false,
    partitionRequired: true,
    ownedIdentities
  })

  return buildResult({
    status: gates.issues.status(),
    issues: gates.issues.sorted(),
    scope: claims.scope,
    journalRole,
    journalId: journal.id,
    dispatchId: journal.dispatchId,
    captureMode: 'CAPTURE_V1',
    txHash: claims.txHash,
    claimDigest: journal.claimDigest,
    proofInventory: inventory,
    sourceAccounts: gates.sourceAccounts,
    members: gates.members,
    receivingAggregates: gates.receivingAggregates,
    ownedAccounting: gates.ownedAccounting,
    totals: gates.totals,
    confirmation: gates.confirmation,
    boundary: gates.boundary,
    observedAt,
    survivingEvidenceDigest: null
  })
}

/**
 * Verify a legacy candidate from a CLOSED historical contract (frozen payout
 * membership, recorded fee) plus the same independent chain session and
 * receipt/structure/partition gates. No capture identity is synthesized: the
 * result keeps dispatchId/claimDigest/proofInventory null, the legacy owner
 * identity, and a safe digest of actually surviving proof material. A null or
 * absent surviving-proof provider yields the LEGACY_PROOF_MISSING unresolved
 * result — journal addresses, current config and caller booleans are never
 * accepted as proof, and no journal/proof row is produced.
 *
 * @param {{
 *   contract: object,
 *   session: object,
 *   survivingProofProvider?: Function|null,
 *   observedAt: string
 * }} request
 * @returns {Promise<object>} PaymentVerificationV1
 */
export async function verifyLegacyPaymentTransaction (request) {
  const { contract, session, survivingProofProvider, observedAt } = request ?? {}
  validateLegacyContract(contract)
  const iso = canonicalIso(observedAt)
  if (iso === null) failRequest('observedAt must be an ISO timestamp')
  const provider = typeof survivingProofProvider === 'function' ? survivingProofProvider : null

  let material = null
  if (provider !== null) material = await provider()
  if (material === null || material === undefined) {
    const issues = newIssues()
    addUnresolved(issues, 'LEGACY_PROOF_MISSING')
    return legacyUnavailableResult({
      scope: contract.scope,
      journalRole: contract.journalRole,
      journalId: contract.journalId,
      txHash: contract.txHash,
      issues,
      observedAt: iso,
      captureUnavailable: false
    })
  }
  if (!isPlainObject(material) ||
    Object.keys(material).sort().join(',') !== SURVIVING_FIELDS.slice().sort().join(',') ||
    material.source !== 'sender-cache' ||
    typeof material.provenanceId !== 'string' || material.provenanceId === '' ||
    typeof material.keyBundleHex !== 'string' || !HEX_BYTES.test(material.keyBundleHex)) {
    const issues = newIssues()
    addUnresolved(issues, 'SURVIVING_PROOF_INVALID')
    return legacyUnavailableResult({
      scope: contract.scope,
      journalRole: contract.journalRole,
      journalId: contract.journalId,
      txHash: contract.txHash,
      issues,
      observedAt: iso,
      captureUnavailable: false
    })
  }

  const { session: preparedSession } = prepareSession(session, iso)
  const ownedIdentities = new Set([
    decodeReceivingIdentity(contract.scope.walletAddress, contract.scope.network).identity
  ])
  const members = contract.members.map(member => {
    let decoded
    try {
      decoded = decodeReceivingIdentity(member.address, contract.scope.network)
    } catch {
      failRequest('legacy contract member address does not decode on the contract network')
    }
    return {
      id: String(member.id),
      leg: member.leg ?? 'PRINCIPAL',
      address: member.address,
      type: decoded.type,
      paymentId: member.paymentId ?? decoded.paymentId ?? null,
      receivingIdentity: decoded.identity,
      grossPiconeros: canonicalAmount(member.grossPiconeros ?? member.actualPiconeros),
      actualPiconeros: canonicalAmount(member.actualPiconeros)
    }
  })
  const claimsLike = {
    txHash: contract.txHash,
    journalRole: contract.journalRole,
    scope: contract.scope,
    sourceAccounts: [],
    change: null,
    ownedTargets: [],
    members,
    receivingAggregates: deriveLegacyAggregates(members)
  }
  const gates = await runGates({
    claimsLike,
    session: preparedSession,
    keyBundleHex: material.keyBundleHex,
    additionalKeyCount: null,
    builtStructure: { mainPublicKey: null, additionalPublicKeys: null, outputKeys: null },
    capturedFeePiconeros: null,
    skipSourceCheck: true,
    partitionRequired: true,
    legacyKind: contract.owner.kind,
    ownedIdentities
  })

  if (contract.recordedFeePiconeros !== null && gates.totals.F !== null &&
    contract.recordedFeePiconeros !== gates.totals.F) {
    // Permitted legacy correction: the recorded fee drifts from the
    // independently verified raw fee; the closure used the raw fee.
    addInformational(gates.issues, 'LEGACY_RECORDED_FEE_MISMATCH')
  }

  return buildResult({
    status: gates.issues.status(),
    issues: gates.issues.sorted(),
    scope: contract.scope,
    journalRole: contract.journalRole,
    journalId: contract.journalId,
    dispatchId: null,
    captureMode: 'LEGACY_SURVIVING_PROOF',
    txHash: contract.txHash,
    claimDigest: null,
    proofInventory: null,
    sourceAccounts: gates.sourceAccounts,
    members: gates.members,
    receivingAggregates: gates.receivingAggregates,
    ownedAccounting: gates.ownedAccounting,
    totals: gates.totals,
    confirmation: gates.confirmation,
    boundary: gates.boundary,
    observedAt: iso,
    survivingEvidenceDigest: survivingEvidenceDigestOf({ contract, material })
  })
}

// --- closed-shape validation and safe fact projection -------------------------------

function validateProofInventory (inventory) {
  if (!isPlainObject(inventory) ||
    Object.keys(inventory).sort().join(',') !== PROOF_INVENTORY_FIELDS.slice().sort().join(',')) {
    return false
  }
  return UUID_RE.test(inventory.proofId) &&
    isSafeNonNegativeInt(inventory.revision) && inventory.revision > 0 &&
    isSafeNonNegativeInt(inventory.masterKeyVersion) && inventory.masterKeyVersion > 0 &&
    isSafeNonNegativeInt(inventory.bindingVersion) && isSafeNonNegativeInt(inventory.envelopeVersion) &&
    isSafeNonNegativeInt(inventory.payloadVersion) &&
    isHex64(inventory.claimDigest) && isHex64(inventory.bindingDigest) &&
    isHex64(inventory.envelopeIntegrityDigest)
}

function validateMembers (members) {
  if (!Array.isArray(members)) return false
  return members.every(member => {
    if (!isPlainObject(member) ||
      Object.keys(member).sort().join(',') !== MEMBER_FIELDS.slice().sort().join(',')) return false
    return typeof member.id === 'string' && CANONICAL_UNSIGNED.test(member.id) &&
      typeof member.leg === 'string' && ISSUE_CODE.test(member.leg) &&
      typeof member.address === 'string' && ADDRESS_TYPES.has(member.type) &&
      (member.paymentId === null || typeof member.paymentId === 'string') &&
      typeof member.receivingIdentity === 'string' && member.receivingIdentity !== '' &&
      CANONICAL_UNSIGNED.test(member.grossPiconeros) && CANONICAL_UNSIGNED.test(member.actualPiconeros)
  })
}

function validateReceivingAggregates (aggregates) {
  if (!Array.isArray(aggregates)) return false
  let previous = null
  return aggregates.every(aggregate => {
    if (!isPlainObject(aggregate) ||
      Object.keys(aggregate).sort().join(',') !== 'amountPiconeros,confirmations,receivingIdentity') return false
    if (previous !== null && !(previous < aggregate.receivingIdentity)) return false
    previous = aggregate.receivingIdentity
    return typeof aggregate.receivingIdentity === 'string' && aggregate.receivingIdentity !== '' &&
      CANONICAL_UNSIGNED.test(aggregate.amountPiconeros) &&
      (aggregate.confirmations === null || isSafeNonNegativeInt(aggregate.confirmations))
  })
}

function validateOwnedAccounting (ownedAccounting) {
  if (!isPlainObject(ownedAccounting) ||
    Object.keys(ownedAccounting).sort().join(',') !== 'outputs,totalPiconeros') return false
  if (ownedAccounting.totalPiconeros !== null && !CANONICAL_UNSIGNED.test(ownedAccounting.totalPiconeros)) return false
  if (!Array.isArray(ownedAccounting.outputs)) return false
  return ownedAccounting.outputs.every(output => {
    if (!isPlainObject(output) ||
      Object.keys(output).sort().join(',') !== 'accountIndex,amountPiconeros,isSpent,outputIndex,subaddressIndex') {
      return false
    }
    return isSafeNonNegativeInt(output.accountIndex) && isSafeNonNegativeInt(output.subaddressIndex) &&
      (output.outputIndex === null || isSafeNonNegativeInt(output.outputIndex)) &&
      CANONICAL_UNSIGNED.test(output.amountPiconeros) &&
      (output.isSpent === true || output.isSpent === false)
  })
}

function validateTotals (totals, status, issues) {
  if (!isPlainObject(totals) ||
    Object.keys(totals).sort().join(',') !== 'D,E,F,O,residual') return false
  for (const key of ['D', 'O', 'F', 'E']) {
    if (totals[key] !== null && !CANONICAL_UNSIGNED.test(totals[key])) return false
  }
  if (totals.residual !== null && !CANONICAL_SIGNED.test(totals.residual)) return false
  if (totals.D !== null && totals.O !== null && totals.F !== null && totals.E !== null &&
    totals.residual !== null) {
    const residual = BigInt(totals.D) - BigInt(totals.O) - BigInt(totals.F) - BigInt(totals.E)
    if (residual.toString() !== totals.residual) return false
  }
  if (status === 'complete') {
    // Complete-result prerequisites (final-review I8): a `complete` closure
    // needs the WHOLE D/O/F/E arithmetic present — never nulls — and zero
    // residual with no material issues.
    if (totals.D === null || totals.O === null || totals.F === null ||
      totals.E === null || totals.residual !== '0') return false
    if (!issues.every(issue => INFORMATIONAL_ISSUES.has(issue))) return false
  }
  if (status === 'rejected' && !issues.some(issue => !INFORMATIONAL_ISSUES.has(issue))) return false
  if (status === 'unsupported' && !issues.some(issue => BOUNDARY_ISSUES.has(issue))) return false
  return true
}

/**
 * Cross-field arithmetic/membership invariants available in the result object
 * itself (final-review I8): classified members must sum to the receiving
 * aggregates, E must equal the classified receipts, O must equal the owned
 * accounting total and the owned outputs must sum to it. `null` fields are
 * always allowed (unresolved facts) — a MATERIALIZED field that contradicts
 * its siblings is not.
 */
function validateCrossFields (result) {
  const memberSums = new Map()
  for (const member of result.members) {
    memberSums.set(
      member.receivingIdentity,
      (memberSums.get(member.receivingIdentity) ?? 0n) + BigInt(member.actualPiconeros)
    )
  }
  const aggregateSums = new Map()
  for (const aggregate of result.receivingAggregates) {
    const amount = BigInt(aggregate.amountPiconeros)
    aggregateSums.set(aggregate.receivingIdentity, (aggregateSums.get(aggregate.receivingIdentity) ?? 0n) + amount)
  }
  // Every materialized aggregate must equal its members' summed actuals.
  for (const [identity, total] of aggregateSums) {
    if (!memberSums.has(identity) || memberSums.get(identity) !== total) return false
  }
  // Members not represented in the aggregates are only allowed while the
  // aggregates are absent (degraded results).
  if ((result.receivingAggregates.length > 0 || result.status === 'complete') && memberSums.size !== aggregateSums.size) return false

  const { totals } = result
  const aggregateTotal = [...aggregateSums.values()].reduce((sum, value) => sum + value, 0n)
  if (totals.E !== null && totals.E !== aggregateTotal.toString()) {
    return false
  }
  const { ownedAccounting } = result
  const outputsTotal = ownedAccounting.outputs.reduce(
    (sum, output) => sum + BigInt(output.amountPiconeros), 0n).toString()
  if (ownedAccounting.totalPiconeros !== null && outputsTotal !== ownedAccounting.totalPiconeros) return false
  if (totals.O !== null && outputsTotal !== totals.O) return false
  if (totals.O !== null && ownedAccounting.totalPiconeros !== null &&
    totals.O !== ownedAccounting.totalPiconeros) {
    return false
  }
  return true
}

/**
 * Closed-shape plus arithmetic/membership/provenance validation of a result
 * object. This guards against caller-fabricated "verified" results — it is NOT
 * a fresh scan. Returns true only when the result is exactly a
 * PaymentVerificationV1 with internally consistent amounts, issue ordering,
 * capture-mode inventory rules and status/issue coherence.
 *
 * @param {object} result
 * @returns {boolean}
 */
export function validatePaymentVerification (result) {
  if (!isPlainObject(result) ||
    Object.keys(result).sort().join(',') !== RESULT_FIELDS.slice().sort().join(',')) {
    return false
  }
  if (result.verificationVersion !== VERIFICATION_VERSION || result.verifierVersion !== VERIFIER_VERSION ||
    result.sdkVersion !== SDK_VERSION || result.provenance !== PROVENANCE) return false
  if (!['complete', 'unsupported', 'unresolved', 'rejected'].includes(result.status)) return false
  if (!Array.isArray(result.issues) ||
    !result.issues.every(issue => typeof issue === 'string' && ISSUE_CODE.test(issue))) return false
  if (new Set(result.issues).size !== result.issues.length) return false
  if (sortedUnique(result.issues).join('|') !== result.issues.join('|')) return false

  if (!isPlainObject(result.scope) || !NETWORKS.has(result.scope.network) ||
    typeof result.scope.walletAddress !== 'string' || result.scope.walletAddress === '') return false
  if (result.journalRole !== null && result.journalRole !== 'REWARDS' && result.journalRole !== 'ESCROW') return false
  if (result.journalId !== null &&
    (typeof result.journalId !== 'string' || !CANONICAL_UNSIGNED.test(result.journalId))) return false
  if (!isHex64(result.txHash)) return false
  if (result.observedAt === null || canonicalIso(result.observedAt) !== result.observedAt) return false
  if (!isPlainObject(result.confirmation) ||
    Object.keys(result.confirmation).sort().join(',') !== 'blockHash,confirmations,height' ||
    !(result.confirmation.height === null || isSafeNonNegativeInt(result.confirmation.height)) ||
    !(result.confirmation.blockHash === null || isHex64(result.confirmation.blockHash)) ||
    !(result.confirmation.confirmations === null || isSafeNonNegativeInt(result.confirmation.confirmations))) return false
  if (!isPlainObject(result.boundary) ||
    Object.keys(result.boundary).sort().join(',') !== 'blockHash,height' ||
    !(result.boundary.height === null || isSafeNonNegativeInt(result.boundary.height)) ||
    !(result.boundary.blockHash === null || isHex64(result.boundary.blockHash))) return false
  if (!Array.isArray(result.sourceAccounts) ||
    !result.sourceAccounts.every(account => typeof account === 'string' && CANONICAL_UNSIGNED.test(account))) return false
  if (!validateMembers(result.members)) return false
  if (!validateReceivingAggregates(result.receivingAggregates)) return false
  if (!validateOwnedAccounting(result.ownedAccounting)) return false
  if (!validateTotals(result.totals, result.status, result.issues)) return false
  if (!validateCrossFields(result)) return false
  // Confirmation/boundary evidence prerequisites for a `complete` result
  // (final-review I8, I4): a complete closure must carry its block facts —
  // audited height, daemon-resolved block hash, derived maturity — and a
  // coherent collection boundary.
  if (result.status === 'complete') {
    if (result.confirmation.height === null || result.confirmation.blockHash === null ||
      result.confirmation.confirmations === null) return false
    if (result.boundary.height === null || result.boundary.blockHash === null) return false
    if (result.confirmation.confirmations < REQUIRED_CONFIRMATIONS ||
      result.boundary.height < result.confirmation.height ||
      result.confirmation.confirmations !== result.boundary.height - result.confirmation.height + 1) return false
    if (result.boundary.height === result.confirmation.height && result.boundary.blockHash !== result.confirmation.blockHash) return false
    if (result.receivingAggregates.some(group => group.confirmations === null || group.confirmations < REQUIRED_CONFIRMATIONS)) return false
    if (result.ownedAccounting.totalPiconeros === null) return false
  }

  if (result.captureMode === 'CAPTURE_V1') {
    if (typeof result.dispatchId !== 'string' || !UUID_RE.test(result.dispatchId)) return false
    if (!isHex64(result.claimDigest)) return false
    if (result.survivingEvidenceDigest !== null) return false
    if (!validateProofInventory(result.proofInventory)) return false
  } else if (result.captureMode === 'LEGACY_SURVIVING_PROOF') {
    if (result.dispatchId !== null || result.proofInventory !== null || result.claimDigest !== null) return false
    if (result.survivingEvidenceDigest !== null && !isHex64(result.survivingEvidenceDigest)) return false
    if (result.status === 'complete' && result.survivingEvidenceDigest === null) return false
  } else if (result.captureMode === null) {
    if (result.dispatchId !== null || result.claimDigest !== null ||
      result.proofInventory !== null || result.survivingEvidenceDigest !== null) return false
  } else {
    return false
  }
  return true
}

/**
 * The substantive safe facts of a verification result: everything except the
 * operation versions, the surviving-evidence digest and the observation time.
 * The projection keeps only STABLE HISTORICAL FACTS (final-review I7):
 * amounts, identities, inclusion facts (heights/block hashes, output
 * positions/indexes), proof revisions/versions and issue codes. Volatile
 * facts are stripped: the advancing top-level AND per-aggregate confirmation
 * counts, and the owned outputs' later `isSpent` state, which normal
 * confirmation advancement or later spending would otherwise invalidate.
 *
 * @param {object} result a valid PaymentVerificationV1
 * @returns {object}
 */
export function paymentVerificationFacts (result) {
  if (!validatePaymentVerification(result)) {
    throw new Error('PAYMENT_VERIFICATION_INVALID')
  }
  const facts = { ...result }
  delete facts.verificationVersion
  delete facts.verifierVersion
  delete facts.sdkVersion
  delete facts.observedAt
  delete facts.boundary
  delete facts.survivingEvidenceDigest
  facts.confirmation = { height: result.confirmation.height, blockHash: result.confirmation.blockHash }
  facts.receivingAggregates = result.receivingAggregates
    .map(aggregate => ({
      receivingIdentity: aggregate.receivingIdentity,
      amountPiconeros: aggregate.amountPiconeros
    }))
    .sort((a, b) => (a.receivingIdentity < b.receivingIdentity ? -1 : 1))
  facts.ownedAccounting = {
    totalPiconeros: result.ownedAccounting.totalPiconeros,
    outputs: result.ownedAccounting.outputs
      .map(({ isSpent, ...output }) => output)
      .sort((a, b) => (a.accountIndex - b.accountIndex) || (a.subaddressIndex - b.subaddressIndex) ||
        ((a.outputIndex ?? 0) - (b.outputIndex ?? 0)))
  }
  return facts
}
