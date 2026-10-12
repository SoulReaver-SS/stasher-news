import { ed25519 } from '@noble/curves/ed25519'
import { keccak256 } from 'js-sha3'

// Encrypted payment-id decryption with the RECIPIENT's view key (lws
// decrypt_payment_id parity) — the wrong-pid recovery fallback.
//
// monero-lws (0.3 and 1.0.x alike) scans every tx against ALL registered
// accounts in ONE pass and shares a single `payment_id` variable across the
// account loop: the FIRST account whose output matches the tx decrypts the
// 8-byte encrypted payment id with ITS derivation, and those bytes are stored
// on every matching account's output row (src/scanner.cpp scan_transaction_base
// / src/util/ownership_test.cpp — `if (!payment_id.first && ...) decrypt`).
// When both sender and recipient are lws-registered (payer change output makes
// a second account match) and the sender scans first — which is what a reorg
// reset re-orders into (the reset re-sorts accounts at the rolled-back height)
// — lws serves the SENDER-side decryption to the recipient: webhooks keyed on
// the issued pid never fire and get_address_txs rows carry the wrong pid.
//
// This module recomputes the pid OUR side: fetch the raw tx from monerod,
// parse the tx-extra, derive Hs(8·a·R) with the recipient's PRIVATE view key
// (the exact ECDH the sender's wallet used to encrypt: Hs(8·r·A)), and XOR out
// the stored bytes. Only the holder of the view key can perform this, so a
// match is cryptographic proof the payment was addressed to the recipient —
// the same trust level as lws's own pid attribution, without lws in the loop.
//
// All functions are pure — no I/O. The ed25519 group ops run on
// @noble/curves (already a dependency): Monero uses the same twisted Edwards
// curve with keccak-based hashing; generate_key_derivation is scalarmult +
// ge_mul8 (three doublings) + point compression, byte-compatible with
// ExtendedPoint.multiply/.double()/toRawBytes.

const CURVE_ORDER = ed25519.CURVE.n
const HASH_KEY_ENCRYPTED_PAYMENT_ID = 0x8d

// Monero tx-extra TLV tags (cryptonote_basic/tx_extra.h)
const TAG_PUBKEY = 0x01
const TAG_NONCE = 0x02
const TAG_ADDITIONAL_PUBKEYS = 0x04
// tx-extra nonce payload prefixes (get_payment_id_from_tx_extra_nonce)
const NONCE_PLAIN_PID = 0x00
const NONCE_ENCRYPTED_PID = 0x01

/**
 * Parse a Monero tx-extra blob.
 * @param {Uint8Array} extra raw tx extra bytes (from monerod get_transactions as_hex)
 * @returns {{ pubKeys: Uint8Array[], encryptedPid: Uint8Array|null, plainPid: Uint8Array|null }}
 */
export function parseTxExtra (extra) {
  const bytes = Buffer.isBuffer(extra) ? extra : Buffer.from(extra ?? [])
  const pubKeys = []
  let encryptedPid = null
  let plainPid = null
  let i = 0
  const readVarint = (start) => {
    let value = 0n
    let shift = 0n
    let pos = start
    while (pos < bytes.length) {
      const b = bytes[pos]
      value |= BigInt(b & 0x7f) << shift
      pos += 1
      if ((b & 0x80) === 0) return { value, next: pos }
      shift += 7n
      if (shift > 63n) return null // malformed varint
    }
    return null
  }
  while (i < bytes.length) {
    const tag = bytes[i]
    if (tag === TAG_PUBKEY) {
      if (i + 33 > bytes.length) break
      pubKeys.push(bytes.subarray(i + 1, i + 33))
      i += 33
    } else if (tag === TAG_NONCE) {
      const len = bytes[i + 1]
      if (len == null || i + 2 + len > bytes.length) break
      const nonce = bytes.subarray(i + 2, i + 2 + len)
      if (nonce.length >= 1 && nonce[0] === NONCE_ENCRYPTED_PID && nonce.length === 9 && encryptedPid == null) {
        encryptedPid = nonce.subarray(1)
      } else if (nonce.length >= 1 && nonce[0] === NONCE_PLAIN_PID && nonce.length === 33 && plainPid == null) {
        plainPid = nonce.subarray(1)
      }
      i += 2 + len
    } else if (tag === TAG_ADDITIONAL_PUBKEYS) {
      const count = readVarint(i + 1)
      if (!count) break
      const { value, next } = count
      if (value > 64n || next + Number(value) * 32 > bytes.length) break
      for (let k = 0; k < Number(value); k++) {
        pubKeys.push(bytes.subarray(next + k * 32, next + (k + 1) * 32))
      }
      i = next + Number(value) * 32
    } else {
      // Unknown/padding byte (0x00 padding, merge-mining tag, ...): resync by
      // skipping one byte. Monero's parser allows partial parses the same way.
      i += 1
    }
  }
  return { pubKeys, encryptedPid, plainPid }
}

function bytesToScalarLE (bytes) {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i])
  }
  return v % CURVE_ORDER
}

/**
 * Monero generate_key_derivation(pubkey, view_key): 8·a·R, compressed.
 * @param {Uint8Array} txPubKey 32-byte tx public key (extra tag 0x01 / additional)
 * @param {string} viewKeyHex recipient PRIVATE view key (little-endian hex)
 * @returns {Uint8Array} 32-byte derivation
 */
export function keyDerivation (txPubKey, viewKeyHex) {
  const viewKey = Buffer.from(viewKeyHex, 'hex')
  if (viewKey.length !== 32) throw new Error('pidDecrypt: view key must be 32 bytes (hex)')
  const point = ed25519.ExtendedPoint.fromHex(Buffer.from(txPubKey).toString('hex'))
  const scalar = bytesToScalarLE(viewKey)
  const derivation = point.multiply(scalar).double().double().double().toRawBytes()
  return derivation
}

/**
 * The 8-byte XOR mask for an encrypted payment id under a derivation
 * (lws decrypt_payment_id / wallet2 hash8: keccak(derivation ‖ 0x8d)[0:8]).
 * @param {Uint8Array} derivation 32 bytes
 * @returns {Uint8Array} 8 bytes
 */
export function maskFromDerivation (derivation) {
  const data = Buffer.concat([Buffer.from(derivation), Buffer.from([HASH_KEY_ENCRYPTED_PAYMENT_ID])])
  return Buffer.from(keccak256(data), 'hex').subarray(0, 8)
}

/** Derive the pid mask directly from a tx public key + recipient view key. */
export function maskFromTxPubKey (txPubKey, viewKeyHex) {
  return maskFromDerivation(keyDerivation(txPubKey, viewKeyHex))
}

/** XOR 8 bytes with a mask (encrypt and decrypt are the same operation). */
export function xorWithMask (pid8, mask) {
  if (pid8.length !== 8 || mask.length !== 8) throw new Error('pidDecrypt: pid and mask must be 8 bytes')
  return Buffer.from(Buffer.from(pid8).map((b, i) => b ^ mask[i]))
}

/**
 * Every payment id a tx extra can yield under the recipient's view key: the
 * decrypted encrypted pid under EACH tx pubkey (primary + additional — a
 * sender paying from subaddresses rotates R per output), plus a plain pid if
 * present. Callers intersect with their known pending pids.
 * @param {Uint8Array} extra raw tx extra
 * @param {string} viewKeyHex recipient private view key
 * @returns {string[]} hex pids (lowercase), [] when the tx carries none
 */
export function paymentIdCandidates (extra, viewKeyHex) {
  return [...iteratePaymentIdCandidates(extra, viewKeyHex)].filter(pid => pid !== null)
}

// Each public-key attempt is a step, including a malformed key (null). The
// worker can yield between expensive curve operations; synchronous callers
// retain paymentIdCandidates' byte-identical string-array contract.
export function * iteratePaymentIdCandidates (extra, viewKeyHex) {
  const parsed = parseTxExtra(extra)
  if (parsed.plainPid != null) yield Buffer.from(parsed.plainPid).toString('hex')
  if (parsed.encryptedPid != null) {
    for (const pubKey of parsed.pubKeys) {
      try {
        yield xorWithMask(parsed.encryptedPid, maskFromTxPubKey(pubKey, viewKeyHex)).toString('hex')
      } catch {
        // a malformed pubkey entry: skip its candidate, keep scanning
        yield null
      }
    }
  }
}

// Monero's varint (base-128, little-endian groups) — the output index suffix
// of derive_public_key's hash. Indices are tiny, but the loop is the spec.
function encodeVarint (n) {
  const out = []
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) }
  out.push(n)
  return Buffer.from(out)
}

/**
 * Recipient ownership proof for a tx output: does any on-chain output key P_i
 * derive from the recipient's keys and one of the tx pubkeys?
 *
 *   P_i = Hs(8·a·R ‖ varint(i))·G + B
 *
 * — monero's generate_key_derivation + derive_public_key, byte for byte. Only
 * the holder of the private view key can compute the derivation, so a match is
 * cryptographic proof the tx pays this recipient (the 0-conf credit gate).
 * Malformed inputs return false rather than throwing.
 * @param {object} params
 * @param {Array<string|null>} params.voutKeys on-chain output keys (hex)
 * @param {Array<string|Uint8Array>} params.txPubKeys tx pubkeys (hex or raw bytes) from the tx extra
 * @param {string} params.viewKeyHex recipient PRIVATE view key (hex)
 * @param {string} params.spendKeyHex recipient PUBLIC spend key (hex compressed point)
 * @returns {boolean}
 */
export function isOutputOwned ({ voutKeys, txPubKeys, viewKeyHex, spendKeyHex }) {
  if (!Array.isArray(voutKeys) || !voutKeys.length || !Array.isArray(txPubKeys) || !txPubKeys.length) return false
  let B
  try { B = ed25519.ExtendedPoint.fromHex(spendKeyHex) } catch { return false }
  for (const pubKey of txPubKeys) {
    let derivation
    try {
      // Chain JSON hands us hex strings while parseTxExtra yields raw bytes;
      // keyDerivation takes point bytes, so normalize either form here.
      const pubKeyBytes = typeof pubKey === 'string' ? Buffer.from(pubKey, 'hex') : Buffer.from(pubKey ?? [])
      derivation = keyDerivation(pubKeyBytes, viewKeyHex)
    } catch { continue }
    for (let i = 0; i < voutKeys.length; i++) {
      const expected = voutKeys[i]
      if (!expected) continue
      const hash = Buffer.from(keccak256(Buffer.concat([Buffer.from(derivation), encodeVarint(i)])), 'hex')
      const scalar = bytesToScalarLE(hash)
      let P
      try { P = ed25519.ExtendedPoint.BASE.multiply(scalar).add(B) } catch { continue }
      if (Buffer.from(P.toRawBytes()).toString('hex') === String(expected).toLowerCase()) return true
    }
  }
  return false
}
