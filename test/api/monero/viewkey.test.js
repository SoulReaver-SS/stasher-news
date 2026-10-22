/* eslint-env jest */

// Unit tests for the view-key envelope encryption helper (Task 2).
//
// AES-256-GCM envelope: a fresh random per-row DEK encrypts the view key;
// the DEK is wrapped by a master-key-derived KEK (HKDF-SHA256, dekVersion
// mixed into the derivation). Pure crypto — no DB, no network.
//
// Run via the node:22.23.4 helper container:
//   docker exec sn-prisma npx jest test/api/monero/viewkey.test.js

const MODULE_PATH = require.resolve('../../../api/monero/viewkey')

// A 32-byte master key, base64-encoded, used for the "valid key" tests.
const VALID_MASTER_B64 = Buffer.from('a'.repeat(32)).toString('base64')
const KEY_B_B64 = Buffer.from('b'.repeat(32)).toString('base64')

// 64-hex-char Monero private view key (per controller resolution #6 — a clean
// literal, not the brief's escaped template artifact).
const VIEWKEY_HEX = '7e3d' + '0'.repeat(60)

// Fields of the MoneroViewKey prisma model that the envelope must match so a
// caller can spread encryptViewKey(...) straight into a prisma create.
const ENVELOPE_KEYS = ['ciphertext', 'iv', 'tag', 'wrappedDek', 'dekVersion']

// In-memory stand-in for the prisma client surface that rotateMasterKey uses
// (models.moneroViewKey.{findMany,update}). findMany honours the
// { dekVersion: { lt: n } } filter the rotation uses to pick lagging rows.
// Buffer fields are cloned on read so update() mutations never leak into the
// snapshots a test may hold, mirroring prisma's value semantics.
function cloneRow (r) {
  return {
    ...r,
    ciphertext: Buffer.from(r.ciphertext),
    iv: Buffer.from(r.iv),
    tag: Buffer.from(r.tag),
    wrappedDek: Buffer.from(r.wrappedDek)
  }
}

function makeFakeModels (seed = []) {
  const store = seed.map((r, i) => ({ id: r.id ?? i + 1, ...r }))
  return {
    store,
    moneroViewKey: {
      async findMany ({ where } = {}) {
        let out = store
        if (where && where.dekVersion && typeof where.dekVersion.lt === 'number') {
          out = store.filter(r => r.dekVersion < where.dekVersion.lt)
        }
        return out.map(cloneRow)
      },
      async update ({ where, data }) {
        const row = store.find(r => r.id === where.id)
        if (!row) throw new Error(`fake models: row ${where.id} not found`)
        Object.assign(row, data)
        return cloneRow(row)
      }
    }
  }
}

let viewkey

beforeEach(() => {
  process.env.VIEWKEY_MASTER_KEY = VALID_MASTER_B64
  jest.resetModules()
  viewkey = require(MODULE_PATH)
})

describe('encryptViewKey / decryptViewKey round-trip', () => {
  test('decrypt(encrypt(plaintext)) returns the original view key', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(viewkey.decryptViewKey(enc)).toBe(VIEWKEY_HEX)
  })

  test('returns Buffers matching the MoneroViewKey model fields', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true)
    expect(Buffer.isBuffer(enc.iv)).toBe(true)
    expect(Buffer.isBuffer(enc.tag)).toBe(true)
    expect(Buffer.isBuffer(enc.wrappedDek)).toBe(true)
    expect(typeof enc.dekVersion).toBe('number')
  })

  test('envelope keys are exactly the MoneroViewKey field names (spread-safe)', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(Object.keys(enc).sort()).toEqual(ENVELOPE_KEYS.slice().sort())
  })

  test('GCM iv is 12 bytes and tag is 16 bytes', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(enc.iv.length).toBe(12)
    expect(enc.tag.length).toBe(16)
  })

  test('fresh DEK and IV per call (ciphertext/wrappedDek/iv are non-deterministic)', () => {
    const a = viewkey.encryptViewKey(VIEWKEY_HEX)
    const b = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false)
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false)
    expect(Buffer.from(a.wrappedDek).equals(Buffer.from(b.wrappedDek))).toBe(false)
  })
})

describe('GCM tamper detection', () => {
  test('flipping a ciphertext byte makes decrypt throw (auth failure)', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const tamperedCt = Buffer.from(enc.ciphertext)
    tamperedCt[0] = tamperedCt[0] ^ 0x01
    expect(() => viewkey.decryptViewKey({ ...enc, ciphertext: tamperedCt })).toThrow()
  })

  test('flipping the GCM tag makes decrypt throw', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const tamperedTag = Buffer.from(enc.tag)
    tamperedTag[0] = tamperedTag[0] ^ 0x01
    expect(() => viewkey.decryptViewKey({ ...enc, tag: tamperedTag })).toThrow()
  })

  test('tampering the wrappedDek makes decrypt throw (wrap is also authenticated)', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const tamperedWrap = Buffer.from(enc.wrappedDek)
    tamperedWrap[tamperedWrap.length - 1] ^= 0x01
    expect(() => viewkey.decryptViewKey({ ...enc, wrappedDek: tamperedWrap })).toThrow()
  })
})

describe('rotateMasterKey (production-safe, non-destructive)', () => {
  test('rewraps every MoneroViewKey row to the new version and all decrypt under it', async () => {
    const r1 = viewkey.encryptViewKey(VIEWKEY_HEX)
    const r2 = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(r1.dekVersion).toBe(1)
    const models = makeFakeModels([r1, r2])

    const out = await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })

    expect(out).toEqual({ version: 2, rotated: 2 })
    const rows = models.store
    expect(rows.every(r => r.dekVersion === 2)).toBe(true)
    expect(viewkey.decryptViewKey(rows[0])).toBe(VIEWKEY_HEX)
    expect(viewkey.decryptViewKey(rows[1])).toBe(VIEWKEY_HEX)
    expect(rows[0].rotatedAt).toEqual(rows[1].rotatedAt)
  })

  test('subsequent encrypts wrap under the new version (fresh wrapping)', async () => {
    const before = viewkey.encryptViewKey(VIEWKEY_HEX)
    const models = makeFakeModels()
    const out = await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })
    expect(out.version).toBe(2)

    const after = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(after.dekVersion).toBe(2)
    expect(Buffer.from(after.wrappedDek).equals(Buffer.from(before.wrappedDek))).toBe(false)
    expect(viewkey.decryptViewKey(after)).toBe(VIEWKEY_HEX)
  })

  test('envelopes sealed under the OLD key still decrypt after rotation (old keys retained)', async () => {
    const oldEnc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const models = makeFakeModels()
    await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })
    expect(viewkey.decryptViewKey(oldEnc)).toBe(VIEWKEY_HEX)
  })

  test('is idempotent: re-running with the same key rewraps zero rows', async () => {
    const models = makeFakeModels([viewkey.encryptViewKey(VIEWKEY_HEX), viewkey.encryptViewKey(VIEWKEY_HEX)])
    const first = await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })
    expect(first).toEqual({ version: 2, rotated: 2 })

    const second = await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })
    expect(second).toEqual({ version: 2, rotated: 0 })
    expect(models.store.every(r => r.dekVersion === 2)).toBe(true)
  })

  test('resumable: a mixed v1/v2 DB (simulated crash) stays decryptable and a follow-up finishes the stragglers', async () => {
    const v1Row = viewkey.encryptViewKey(VIEWKEY_HEX)
    const masterkey = require('../../../api/monero/masterkey')
    masterkey.addMasterKeyVersion(KEY_B_B64)
    const v2Row = viewkey.encryptViewKey(VIEWKEY_HEX)

    const models = makeFakeModels([v1Row, v2Row])
    const beforeWrap = Buffer.from(v2Row.wrappedDek)

    const out = await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })

    expect(out).toEqual({ version: 2, rotated: 1 })
    expect(models.store[0].dekVersion).toBe(2)
    expect(models.store[1].dekVersion).toBe(2)
    expect(viewkey.decryptViewKey(models.store[0])).toBe(VIEWKEY_HEX)
    expect(viewkey.decryptViewKey(models.store[1])).toBe(VIEWKEY_HEX)
    expect(Buffer.from(models.store[1].wrappedDek).equals(beforeWrap)).toBe(true)
  })

  test('a poison row that fails to decrypt does not block the other rows (resumable)', async () => {
    const good1 = viewkey.encryptViewKey(VIEWKEY_HEX) // id 1, v1
    const poison = viewkey.encryptViewKey(VIEWKEY_HEX) // id 2, v1 — corrupted below
    const good2 = viewkey.encryptViewKey(VIEWKEY_HEX) // id 3, v1

    // Corrupt the poison row's ciphertext so decryptViewKey throws a GCM auth
    // failure — simulating a corrupted/undecryptable envelope stranded in the DB.
    poison.ciphertext = Buffer.from(poison.ciphertext)
    poison.ciphertext[0] ^= 0x01

    const models = makeFakeModels([good1, poison, good2])

    let caught
    try {
      await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })
    } catch (err) {
      caught = err
    }

    // The function throws an aggregate error naming the failed row …
    expect(caught).toBeDefined()
    expect(caught.message).toMatch(/2 of 3/)
    expect(caught.message).toMatch(/ids: 2/)
    expect(caught.rotated).toBe(2)
    expect(caught.targetVersion).toBe(2)
    expect(Array.isArray(caught.failures)).toBe(true)
    expect(caught.failures).toHaveLength(1)
    expect(caught.failures[0].id).toBe(2)
    expect(caught.failures[0].dekVersion).toBe(1)

    // … but the two good rows WERE re-wrapped to v2 and still decrypt correctly.
    expect(models.store[0].dekVersion).toBe(2)
    expect(viewkey.decryptViewKey(models.store[0])).toBe(VIEWKEY_HEX)
    expect(models.store[2].dekVersion).toBe(2)
    expect(viewkey.decryptViewKey(models.store[2])).toBe(VIEWKEY_HEX)

    // The poison row is untouched: still v1 (so a re-run will retry only it) and
    // still undecryptable. Critically, good2 (after the poison row) was NOT stranded.
    expect(models.store[1].dekVersion).toBe(1)
    expect(() => viewkey.decryptViewKey(models.store[1])).toThrow()
  })

  test('old-key retention allows restoring a v1 backup envelope after rotation', async () => {
    const backup = viewkey.encryptViewKey(VIEWKEY_HEX)
    const models = makeFakeModels([viewkey.encryptViewKey(VIEWKEY_HEX)])
    await viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models })

    const masterkey = require('../../../api/monero/masterkey')
    expect(masterkey.getMasterKey(1).equals(Buffer.from('a'.repeat(32)))).toBe(true)
    expect(viewkey.decryptViewKey(backup)).toBe(VIEWKEY_HEX)
  })

  test('rejects a wrong-length new key without changing state or touching rows', async () => {
    const models = makeFakeModels([viewkey.encryptViewKey(VIEWKEY_HEX)])
    await expect(viewkey.rotateMasterKey({ newKeyB64: Buffer.from('short').toString('base64'), models })).rejects.toThrow(/32 bytes/)
    expect(models.store[0].dekVersion).toBe(1)
    expect(viewkey.decryptViewKey(models.store[0])).toBe(VIEWKEY_HEX)
  })

  test('throws when models is missing or lacks the required methods', async () => {
    await expect(viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64 })).rejects.toThrow(/requires \{ models \}/)
    await expect(viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models: {} })).rejects.toThrow(/requires \{ models \}/)
    await expect(viewkey.rotateMasterKey({ newKeyB64: KEY_B_B64, models: { moneroViewKey: {} } })).rejects.toThrow(/requires \{ models \}/)
  })

  test('throws when newKeyB64 is not provided', async () => {
    await expect(viewkey.rotateMasterKey({ models: makeFakeModels() })).rejects.toThrow(/requires \{ newKeyB64 \}/)
  })
})

describe('VIEWKEY_MASTER_KEY env handling (fail-closed)', () => {
  test('missing VIEWKEY_MASTER_KEY throws on encrypt (never silently weak)', () => {
    delete process.env.VIEWKEY_MASTER_KEY
    jest.resetModules()
    const fresh = require(MODULE_PATH)
    expect(() => fresh.encryptViewKey(VIEWKEY_HEX)).toThrow(/VIEWKEY_MASTER_KEY/)
  })

  test('empty VIEWKEY_MASTER_KEY throws on encrypt', () => {
    process.env.VIEWKEY_MASTER_KEY = ''
    jest.resetModules()
    const fresh = require(MODULE_PATH)
    expect(() => fresh.encryptViewKey(VIEWKEY_HEX)).toThrow(/VIEWKEY_MASTER_KEY/)
  })

  test('wrong-length VIEWKEY_MASTER_KEY throws on encrypt', () => {
    process.env.VIEWKEY_MASTER_KEY = Buffer.from('short').toString('base64')
    jest.resetModules()
    const fresh = require(MODULE_PATH)
    expect(() => fresh.encryptViewKey(VIEWKEY_HEX)).toThrow(/32 bytes/)
  })
})
