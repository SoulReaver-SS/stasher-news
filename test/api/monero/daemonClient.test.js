/* eslint-env jest */

// Unit tests for the monerod restricted-RPC client (Task 6 / spec §5.5).
//
// monero-lws returns no block hash in its /get_address_txs response, so the
// indexer sources the cursor's `since_tx_block_hash` from monerod's
// `get_block_header_by_height` JSON-RPC instead. Transport is dependency-
// injected (same DI seam + {status, ok, text} contract the lwsClient tests use)
// so these tests exercise the REAL request/response behaviour without touching
// the network.
//
// Run via the node:22.23.4 helper container:
//   docker exec sn-prisma npx jest test/api/monero/daemonClient.test.js

const http = require('node:http')

const DAEMON_MODULE = require.resolve('../../../api/monero/daemonClient')

const MONEROD_URL = 'http://monerod:38081'

let daemon

beforeEach(() => {
  jest.resetModules()
  delete process.env.MONEROD_URL
  daemon = require(DAEMON_MODULE)
})

// ---- mock-transport helpers (same shape as lwsClient tests) ----------------

function jsonRes (status, obj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(obj)
  }
}

function recordingTransport (responder) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return responder({ url, opts }, calls.length)
  }
  fn.calls = calls
  return fn
}

function makeClient (transport, opts = {}) {
  return daemon.createDaemonClient({ daemonUrl: MONEROD_URL, transport, ...opts })
}

// ---- getBlockHashByHeight --------------------------------------------------

describe('getBlockHashByHeight', () => {
  test('POSTs a JSON-RPC get_block_header_by_height and returns result.block_header.hash', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      id: '0',
      jsonrpc: '2.0',
      result: { block_header: { hash: 'deadbeef', height: 195, depth: 10 } }
    }))
    const client = makeClient(t)

    const hash = await client.getBlockHashByHeight(195)

    expect(t.calls[0].url).toBe(MONEROD_URL + '/json_rpc')
    expect(t.calls[0].opts.method).toBe('POST')
    const body = JSON.parse(t.calls[0].opts.body)
    expect(body).toEqual({ jsonrpc: '2.0', id: '0', method: 'get_block_header_by_height', params: { height: 195 } })
    expect(hash).toBe('deadbeef')
  })

  test('throws a clear error when monerod returns an RPC-level error', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      id: '0',
      jsonrpc: '2.0',
      error: { code: -26, message: 'block not found' }
    }))
    const client = makeClient(t)
    await expect(client.getBlockHashByHeight(999999)).rejects.toThrow(/get_block_header_by_height/)
  })

  test('throws on a non-2xx HTTP status', async () => {
    const t = recordingTransport(() => jsonRes(500, {}))
    const client = makeClient(t)
    await expect(client.getBlockHashByHeight(195)).rejects.toThrow(/HTTP 500/)
  })

  test('throws when the response is missing block_header.hash', async () => {
    const t = recordingTransport(() => jsonRes(200, { id: '0', jsonrpc: '2.0', result: {} }))
    const client = makeClient(t)
    await expect(client.getBlockHashByHeight(195)).rejects.toThrow(/block_header/)
  })
})

// ---- config fail-closed ----------------------------------------------------

describe('configuration', () => {
  test('throws a clear error when MONEROD_URL is unset (never silently skip block-hash sourcing)', async () => {
    const client = daemon.createDaemonClient({ transport: recordingTransport(() => jsonRes(200, {})) })
    await expect(client.getBlockHashByHeight(195)).rejects.toThrow(/MONEROD_URL/)
  })

  test('uses MONEROD_URL from the env for the singleton', async () => {
    process.env.MONEROD_URL = 'http://env-monerod:38081'
    jest.resetModules()
    const fresh = require(DAEMON_MODULE)
    const t = recordingTransport(() => jsonRes(200, {
      id: '0', jsonrpc: '2.0', result: { block_header: { hash: 'cafe', height: 1 } }
    }))
    const client = fresh.createDaemonClient({ transport: t }) // daemonUrl read from env when omitted
    delete process.env.MONEROD_URL
    await client.getBlockHashByHeight(1)
    expect(t.calls[0].url).toBe('http://env-monerod:38081/json_rpc')
  })
})

// ---- getTransactions --------------------------------------------------------

describe('getTransactions', () => {
  test('POSTs to the plain /get_transactions endpoint with decode_as_json and returns extras', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [{
        tx_hash: 'abc123',
        as_json: JSON.stringify({ version: 2, extra: [1, 2, 3, 4] })
      }],
      missed_txs: []
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['abc123', 'missing'])
    expect(t.calls[0].url).toBe(`${MONEROD_URL}/get_transactions`)
    expect(JSON.parse(t.calls[0].opts.body)).toEqual({ txs_hashes: ['abc123', 'missing'], decode_as_json: true })
    expect(out).toEqual([{ hash: 'abc123', extra: Buffer.from([1, 2, 3, 4]), vout: [] }])
  })

  test('normalizes a hex-string extra (older monerod builds) to a Buffer', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [{ tx_hash: 'abc', as_json: JSON.stringify({ extra: 'deadbeef' }) }]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['abc'])
    expect(out[0].extra).toEqual(Buffer.from('deadbeef', 'hex'))
  })

  test('omits malformed hex extras instead of silently truncating them', async () => {
    // Finding 1: Buffer.from('01zz', 'hex') silently yields [0x01] and an odd
    // string is truncated too; converting before validating let a malformed
    // acquisition pass the reader's Buffer check as usable evidence.
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [
        { tx_hash: 'trailing', as_json: JSON.stringify({ extra: '01zz' }) },
        { tx_hash: 'odd-length', as_json: JSON.stringify({ extra: 'abc' }) },
        { tx_hash: 'good', as_json: JSON.stringify({ extra: 'deadbeef' }) }
      ]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['trailing', 'odd-length', 'good'])
    expect(out).toEqual([{ hash: 'good', extra: Buffer.from('deadbeef', 'hex'), vout: [] }])
  })

  test('omits malformed byte-array extras instead of coercing or truncating entries', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [
        { tx_hash: 'fraction', as_json: JSON.stringify({ extra: [1.5, 2] }) },
        { tx_hash: 'negative', as_json: JSON.stringify({ extra: [-1] }) },
        { tx_hash: 'stringy', as_json: JSON.stringify({ extra: [1, '2'] }) },
        { tx_hash: 'out-of-range', as_json: JSON.stringify({ extra: [256] }) },
        { tx_hash: 'unsafe', as_json: JSON.stringify({ extra: [2 ** 53] }) },
        { tx_hash: 'empty-array', as_json: JSON.stringify({ extra: [] }) }
      ]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['fraction', 'negative', 'stringy', 'out-of-range', 'unsafe', 'empty-array'])
    expect(out).toEqual([{ hash: 'empty-array', extra: Buffer.alloc(0), vout: [] }])
  })

  test('keeps a legitimately empty extra ("" or []) as a zero-byte Buffer', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [
        { tx_hash: 'empty-string', as_json: JSON.stringify({ extra: '' }) },
        { tx_hash: 'empty-array', as_json: JSON.stringify({ extra: [] }) }
      ]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['empty-string', 'empty-array'])
    expect(out).toEqual([
      { hash: 'empty-string', extra: Buffer.alloc(0), vout: [] },
      { hash: 'empty-array', extra: Buffer.alloc(0), vout: [] }
    ])
  })

  test('carries vout target keys (legacy and tagged shapes)', async () => {
    const asJson = JSON.stringify({
      extra: [1, 2, 3],
      vout: [{ target: { key: 'aa' } }, { target: { tagged_key: { key: 'bb' } } }]
    })
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [{ tx_hash: 'h', as_json: asJson }]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['h'])
    expect(out[0].vout).toEqual(['aa', 'bb'])
  })

  test('preserves null for vout entries without a target key', async () => {
    const asJson = JSON.stringify({
      extra: [1],
      vout: [{ target: {} }, { target: { key: 'cc' } }, {}]
    })
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [{ tx_hash: 'h', as_json: asJson }]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['h'])
    expect(out[0].vout).toEqual([null, 'cc', null])
  })

  test('omits txs with unparseable as_json rather than throwing', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'OK',
      txs: [
        { tx_hash: 'bad', as_json: '{not json' },
        { tx_hash: 'none' },
        { tx_hash: 'good', as_json: JSON.stringify({ extra: [9] }) }
      ]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['bad', 'none', 'good'])
    expect(out).toEqual([{ hash: 'good', extra: Buffer.from([9]), vout: [] }])
  })

  test('throws a DaemonHttpError on a non-2xx status', async () => {
    const t = recordingTransport(() => jsonRes(500, {}))
    const client = makeClient(t)
    await expect(client.getTransactions(['abc'])).rejects.toThrow(/HTTP 500/)
  })

  test('batches >MAX_TX_HASHES_PER_REQUEST hashes and merges every batch\'s txs', async () => {
    const hashes = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(64, '0'))
    const t = recordingTransport(({ opts }) => {
      const { txs_hashes: batch } = JSON.parse(opts.body)
      return jsonRes(200, {
        status: 'OK',
        txs: batch.map((h) => ({ tx_hash: h, as_json: JSON.stringify({ extra: [1] }) }))
      })
    })
    const client = makeClient(t)
    const out = await client.getTransactions(hashes)
    expect(daemon.MAX_TX_HASHES_PER_REQUEST).toBeLessThanOrEqual(100)
    expect(t.calls.map(c => JSON.parse(c.opts.body).txs_hashes.length)).toEqual([50, 50, 20])
    expect(out).toHaveLength(120)
    expect(out[0]).toEqual({ hash: hashes[0], extra: Buffer.from([1]), vout: [] })
    expect(out[119]).toEqual({ hash: hashes[119], extra: Buffer.from([1]), vout: [] })
  })

  test('throws on a non-OK status (restricted-mode cap) instead of returning []', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'Too many transactions requested in restricted mode'
    }))
    const client = makeClient(t)
    const err = await client.getTransactions(['abc']).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/get_transactions/)
    expect(err.message).toMatch(/Too many transactions requested in restricted mode/)
  })

  test('returns [] for an empty hash list without issuing a request', async () => {
    const t = recordingTransport(() => jsonRes(200, { status: 'OK' }))
    const client = makeClient(t)
    expect(await client.getTransactions([])).toEqual([])
    expect(t.calls).toHaveLength(0)
  })
})

// ---- module surface --------------------------------------------------------

describe('module surface', () => {
  test('exports a singleton daemonClient with getBlockHashByHeight and getTransactions', () => {
    expect(daemon.daemonClient).toBeDefined()
    expect(typeof daemon.daemonClient.getBlockHashByHeight).toBe('function')
    expect(typeof daemon.daemonClient.getTransactions).toBe('function')
  })

  test('createDaemonClient builds a real transport when none is injected (no throw)', () => {
    expect(() => daemon.createDaemonClient({ daemonUrl: MONEROD_URL })).not.toThrow()
  })
})

// ---- getPaymentTransactions (strict raw evidence for the payment-proof chain
// adapter; strictly additive to getTransactions, which keeps its own shape) ----

const HASH_A = 'aa'.repeat(32)
const HASH_B = 'bb'.repeat(32)

// Build one monerod /get_transactions entry whose decoded tx has one key input,
// two outputs (legacy key + tagged_key) and a 7-piconero RingCT fee.
function rawTxEntry (hash, overrides = {}) {
  const tx = {
    version: 2,
    extra: [1, 2, 3, 4],
    vin: [{ key: { k_image: '11'.repeat(32), amount: 100 } }],
    vout: [
      { amount: 33, target: { key: '22'.repeat(32) } },
      { amount: 60, target: { tagged_key: { key: '33'.repeat(32) } } }
    ],
    rct_signatures: { txnFee: 7, outPk: [] },
    ...(overrides.tx ?? {})
  }
  return {
    tx_hash: hash,
    block_height: 195,
    in_pool: false,
    output_indices: [5, 6],
    as_json: overrides.asJson === undefined ? JSON.stringify(tx) : overrides.asJson,
    ...(overrides.entry ?? {})
  }
}

function rawResponse (entries, extra = {}) {
  return jsonRes(200, { status: 'OK', txs: entries, missed_hashes: [], missed_tx: [], ...extra })
}

async function expectRawCode (promise, code) {
  let caught = null
  try { caught = await promise } catch (e) { caught = e }
  expect(caught).not.toBeNull()
  expect(caught.code).toBe(code)
}

describe('getPaymentTransactions', () => {
  // I1: strict raw records now also carry `blockHash`, resolved per distinct
  // block_height through get_block_header_by_height on the same transport.
  const headerResponse = hash => jsonRes(200, {
    id: '0',
    jsonrpc: '2.0',
    result: hash === null ? {} : { block_header: { hash } }
  })
  const routedTransport = (getTransactionsResponder, headerHash = 'dd'.repeat(32)) =>
    recordingTransport(({ url, opts }) => {
      if (!url.endsWith('/get_transactions')) return headerResponse(headerHash)
      return getTransactionsResponder({ url, opts })
    })

  test('POSTs {txs_hashes, decode_as_json: true, prune: false} and returns strict raw records', async () => {
    const t = routedTransport(() => rawResponse([rawTxEntry(HASH_A)]))
    const client = makeClient(t)

    const out = await client.getPaymentTransactions([HASH_A])

    expect(t.calls[0].url).toBe(`${MONEROD_URL}/get_transactions`)
    expect(JSON.parse(t.calls[0].opts.body)).toEqual({
      txs_hashes: [HASH_A],
      decode_as_json: true,
      prune: false
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      txHash: HASH_A,
      isCoinbase: false,
      inputKeyImages: ['11'.repeat(32)],
      voutKeys: ['22'.repeat(32), '33'.repeat(32)],
      outputIndices: [5, 6],
      feePiconeros: 7n,
      blockHeight: 195,
      inTxPool: false,
      extra: '01020304',
      // I1: resolved from get_block_header_by_height, never fabricated.
      blockHash: 'dd'.repeat(32)
    })
    const headerCall = t.calls.find(c => c.url.endsWith('/json_rpc'))
    expect(headerCall).toBeDefined()
    expect(JSON.parse(headerCall.opts.body)).toEqual({
      jsonrpc: '2.0',
      id: '0',
      method: 'get_block_header_by_height',
      params: { height: 195 }
    })
  })

  test('resolves one block hash per DISTINCT block_height and attaches it to every record', async () => {
    const entryB = rawTxEntry(HASH_B, { entry: { block_height: 196 } })
    const t = routedTransport(() => rawResponse([rawTxEntry(HASH_A), entryB]))
    const client = makeClient(t)

    const out = await client.getPaymentTransactions([HASH_A, HASH_B])

    const headerCalls = t.calls.filter(c => c.url.endsWith('/json_rpc'))
    expect(headerCalls.map(c => JSON.parse(c.opts.body).params.height).sort()).toEqual([195, 196])
    const byHash = Object.fromEntries(out.map(record => [record.txHash, record]))
    expect(byHash[HASH_A].blockHash).toBe('dd'.repeat(32))
    expect(byHash[HASH_B].blockHash).toBe('dd'.repeat(32))
    // Three transactions sharing ONE height resolve that height exactly once.
    const shared = routedTransport(() => rawResponse([
      rawTxEntry(HASH_A),
      rawTxEntry(HASH_B, { entry: { block_height: 195 } })
    ]))
    const client2 = makeClient(shared)
    const out2 = await client2.getPaymentTransactions([HASH_A, HASH_B])
    expect(shared.calls.filter(c => c.url.endsWith('/json_rpc'))).toHaveLength(1)
    expect(out2.every(record => record.blockHash === 'dd'.repeat(32))).toBe(true)
  })

  test('attaches null for an unresolvable header hash — never a fabricated value', async () => {
    const entryB = rawTxEntry(HASH_B, { entry: { block_height: 196 } })
    // Height 195 resolves; height 196 returns a header response without a
    // usable hash.
    const t = recordingTransport(({ url, opts }) => {
      if (!url.endsWith('/get_transactions')) {
        const { params } = JSON.parse(opts.body)
        return headerResponse(params.height === 196 ? null : 'dd'.repeat(32))
      }
      return rawResponse([rawTxEntry(HASH_A), entryB])
    })
    const client = makeClient(t)
    const out = await client.getPaymentTransactions([HASH_A, HASH_B])
    const byHash = Object.fromEntries(out.map(record => [record.txHash, record]))
    expect(byHash[HASH_A].blockHash).toBe('dd'.repeat(32))
    expect(byHash[HASH_B].blockHash).toBeNull()

    const missingHeader = routedTransport(() => rawResponse([rawTxEntry(HASH_A)]), null)
    const client2 = makeClient(missingHeader)
    const out2 = await client2.getPaymentTransactions([HASH_A])
    expect(out2[0].blockHash).toBeNull()
  })

  test('header transport and RPC failures keep the existing throw discipline', async () => {
    const httpFail = recordingTransport(({ url }) => {
      if (!url.endsWith('/get_transactions')) return jsonRes(500, {})
      return rawResponse([rawTxEntry(HASH_A)])
    })
    const client = makeClient(httpFail)
    await expect(client.getPaymentTransactions([HASH_A])).rejects.toThrow(/HTTP 500/)

    const rpcFail = recordingTransport(({ url }) => {
      if (!url.endsWith('/get_transactions')) {
        return jsonRes(200, { id: '0', jsonrpc: '2.0', error: { code: -26, message: 'block not found' } })
      }
      return rawResponse([rawTxEntry(HASH_A)])
    })
    const client2 = makeClient(rpcFail)
    await expect(client2.getPaymentTransactions([HASH_A])).rejects.toThrow(/get_block_header_by_height/)
  })

  test('accepts as_json as an already-parsed object and extra as a hex string', async () => {
    const t = recordingTransport(() => rawResponse([{
      tx_hash: HASH_A,
      block_height: 1,
      in_pool: false,
      output_indices: [0],
      as_json: {
        version: 2,
        extra: 'deadbeef',
        vin: [{ key: { k_image: '11'.repeat(32) } }],
        vout: [{ amount: 1, target: { key: '22'.repeat(32) } }],
        rct_signatures: { txnFee: 1 }
      }
    }]))
    const client = makeClient(t)
    const out = await client.getPaymentTransactions([HASH_A])
    expect(out[0].extra).toBe('deadbeef')
    expect(out[0].feePiconeros).toBe(1n)
  })

  test('accepts a coinbase gen vin with zero fee and no key images', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, {
      tx: {
        version: 2,
        extra: [],
        vin: [{ gen: { height: 194 } }],
        vout: [{ amount: 100, target: { key: '22'.repeat(32) } }],
        rct_signatures: {}
      },
      entry: { output_indices: [9] }
    })]))
    const client = makeClient(t)
    const out = await client.getPaymentTransactions([HASH_A])
    expect(out[0]).toMatchObject({
      txHash: HASH_A,
      isCoinbase: true,
      inputKeyImages: [],
      voutKeys: ['22'.repeat(32)],
      outputIndices: [9],
      feePiconeros: 0n,
      inTxPool: false
    })
    expect(out[0].extra).toBe('')
  })

  test.each([
    [0, []],
    [1, [1]],
    [50, [50]],
    [51, [50, 1]],
    [101, [50, 50, 1]]
  ])('batches %i hash(es) at MAX_TX_HASHES_PER_REQUEST', async (count, expectedBatches) => {
    const hashes = Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0'))
    const t = routedTransport(({ opts }) => {
      const { txs_hashes: batch } = JSON.parse(opts.body)
      return rawResponse(batch.map(h => rawTxEntry(h, {
        tx: { extra: [1] },
        entry: { output_indices: undefined }
      })))
    })
    const client = makeClient(t)
    const out = await client.getPaymentTransactions(hashes)
    const batchCalls = t.calls.filter(c => c.url.endsWith('/get_transactions'))
    expect(batchCalls.map(c => JSON.parse(c.opts.body).txs_hashes.length)).toEqual(expectedBatches)
    expect(out).toHaveLength(count)
    if (count > 0) expect(out[count - 1].txHash).toBe(hashes[count - 1])
    if (count === 0) expect(t.calls).toHaveLength(0)
  })

  test('throws DaemonRpcError on a non-OK status (restricted-mode cap included)', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      status: 'Too many transactions requested in restricted mode'
    }))
    const client = makeClient(t)
    const err = await client.getPaymentTransactions([HASH_A]).catch(e => e)
    expect(err.name).toBe('DaemonRpcError')
    expect(err.message).toMatch(/Too many transactions requested in restricted mode/)
  })

  test('throws DaemonHttpError on a non-2xx status', async () => {
    const t = recordingTransport(() => jsonRes(500, {}))
    const client = makeClient(t)
    await expect(client.getPaymentTransactions([HASH_A])).rejects.toThrow(/HTTP 500/)
  })

  test('refuses missed hashes instead of silently returning fewer transactions', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A)], { missed_hashes: [HASH_B] }))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A, HASH_B]), 'DAEMON_MISSED_TX_HASH')
  })

  test('refuses legacy missed_tx reports too', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A)], { missed_tx: [HASH_B] }))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A, HASH_B]), 'DAEMON_MISSED_TX_HASH')
  })

  test('refuses pruned/partial daemon forms', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, { entry: { pruned_as_json: '{}' } })]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_PRUNED_JSON_UNSUPPORTED')
  })

  test('refuses unparseable as_json', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, { asJson: '{not json' })]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_TX_JSON_MALFORMED')
  })

  test('refuses missing as_json', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, { entry: { as_json: undefined } })]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_TX_JSON_MISSING')
  })

  test('refuses a returned tx_hash that was not requested, and duplicates', async () => {
    const unknownHash = 'cc'.repeat(32)
    const t = recordingTransport(() => rawResponse([rawTxEntry(unknownHash)]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_HASH_MISMATCH')

    const dup = recordingTransport(() => rawResponse([rawTxEntry(HASH_A), rawTxEntry(HASH_A)]))
    const client2 = makeClient(dup)
    await expectRawCode(client2.getPaymentTransactions([HASH_A]), 'RAW_TX_DUPLICATE')
  })

  test('refuses in-pool transactions for the confirmed-only adapter', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, { entry: { in_pool: true } })]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_TX_IN_POOL')
  })

  test('refuses duplicate input key images and duplicate output keys', async () => {
    const dupKI = rawTxEntry(HASH_A, {
      tx: { vin: [{ key: { k_image: '11'.repeat(32) } }, { key: { k_image: '11'.repeat(32) } }] },
      entry: { output_indices: [5, 6] }
    })
    const t = recordingTransport(() => rawResponse([dupKI]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'DUPLICATE_INPUT_KEY_IMAGE')

    const dupOut = rawTxEntry(HASH_A, {
      tx: { vout: [{ target: { key: '22'.repeat(32) } }, { target: { key: '22'.repeat(32) } }] }
    })
    const t2 = recordingTransport(() => rawResponse([dupOut]))
    const client2 = makeClient(t2)
    await expectRawCode(client2.getPaymentTransactions([HASH_A]), 'DUPLICATE_OUTPUT_KEY')
  })

  test('refuses vout entries without a usable target key', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, {
      tx: { vout: [{ amount: 1, target: {} }] },
      entry: { output_indices: [5] }
    })]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_VOUT_KEY_MALFORMED')
  })

  test('refuses unsafe integers before BigInt conversion and length-mismatched output_indices', async () => {
    const unsafeFee = rawTxEntry(HASH_A, { tx: { rct_signatures: { txnFee: 2 ** 53 } } })
    const t = recordingTransport(() => rawResponse([unsafeFee]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_INTEGER_UNSAFE')

    const boundaryFee = rawTxEntry(HASH_A, { tx: { rct_signatures: { txnFee: Number.MAX_SAFE_INTEGER } } })
    const tOk = recordingTransport(() => rawResponse([boundaryFee]))
    const clientOk = makeClient(tOk)
    const ok = await clientOk.getPaymentTransactions([HASH_A])
    expect(ok[0].feePiconeros).toBe(BigInt(Number.MAX_SAFE_INTEGER))

    const badIndices = rawTxEntry(HASH_A, { entry: { output_indices: [5] } })
    const t2 = recordingTransport(() => rawResponse([badIndices]))
    const client2 = makeClient(t2)
    await expectRawCode(client2.getPaymentTransactions([HASH_A]), 'RAW_OUTPUT_INDICES_LENGTH')

    const unsafeIndex = rawTxEntry(HASH_A, { entry: { output_indices: [5, 2 ** 53] } })
    const t3 = recordingTransport(() => rawResponse([unsafeIndex]))
    const client3 = makeClient(t3)
    await expectRawCode(client3.getPaymentTransactions([HASH_A]), 'RAW_INTEGER_UNSAFE')

    const unsafeHeight = rawTxEntry(HASH_A, { entry: { block_height: 1.5 } })
    const t4 = recordingTransport(() => rawResponse([unsafeHeight]))
    const client4 = makeClient(t4)
    await expectRawCode(client4.getPaymentTransactions([HASH_A]), 'RAW_INTEGER_UNSAFE')
  })

  test('refuses missing fee on non-coinbase transactions', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A, {
      tx: { rct_signatures: { outPk: [] } }
    })]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_FEE_MISSING')
  })

  test('refuses missing extra on non-coinbase transactions and malformed extra shapes', async () => {
    const noExtra = rawTxEntry(HASH_A, { tx: { extra: undefined } })
    const t = recordingTransport(() => rawResponse([noExtra]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions([HASH_A]), 'RAW_EXTRA_MISSING')

    const badHexExtra = rawTxEntry(HASH_A, { tx: { extra: 'zz' } })
    const t2 = recordingTransport(() => rawResponse([badHexExtra]))
    const client2 = makeClient(t2)
    await expectRawCode(client2.getPaymentTransactions([HASH_A]), 'RAW_EXTRA_MALFORMED')
  })

  test('refuses malformed hash input and duplicate requested hashes', async () => {
    const t = recordingTransport(() => rawResponse([]))
    const client = makeClient(t)
    await expectRawCode(client.getPaymentTransactions(['NOPE']), 'RAW_HASH_INVALID')
    await expectRawCode(client.getPaymentTransactions([HASH_A.toUpperCase()]), 'RAW_HASH_INVALID')
    await expectRawCode(client.getPaymentTransactions([HASH_A, HASH_A]), 'RAW_HASH_DUPLICATE')
    await expectRawCode(client.getPaymentTransactions('aa'), 'RAW_HASH_LIST_INVALID')
    expect(t.calls).toHaveLength(0)
  })

  test('keeps the existing getTransactions surface untouched', async () => {
    const t = recordingTransport(() => rawResponse([rawTxEntry(HASH_A)]))
    const client = makeClient(t)
    const lenient = await client.getTransactions([HASH_A])
    expect(lenient).toEqual([{ hash: HASH_A, extra: Buffer.from([1, 2, 3, 4]), vout: ['22'.repeat(32), '33'.repeat(32)] }])
  })
})

// ---- request deadlines (Finding 1) -----------------------------------------
//
// The raw-evidence reader retries ONLY deadline expiry, so a deadline must be
// distinguishable from every other transport/HTTP/RPC failure. Each request
// path aborts its AbortController with a DaemonTimeoutError and the node
// transport destroys the socket with the signal's reason (never a fresh
// generic Error), so the typed error is what surfaces to callers.

describe('request deadlines', () => {
  test('DaemonTimeoutError carries the fixed DAEMON_TIMEOUT code', () => {
    const err = new daemon.DaemonTimeoutError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('DaemonTimeoutError')
    expect(err.code).toBe('DAEMON_TIMEOUT')
  })

  // Transport double upholding the same contract as the real node transport:
  // a deadline rejects the request with the supplied signal's reason.
  function hangingTransport () {
    const calls = []
    const fn = (url, { signal } = {}) => new Promise((resolve, reject) => {
      calls.push({ url, signal })
      const fail = () => reject(signal.reason)
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
    fn.calls = calls
    return fn
  }

  test.each([
    ['rpc (block header lookup)', client => client.getBlockHashByHeight(1)],
    ['getTransactions', client => client.getTransactions([HASH_A])],
    ['getPaymentTransactions', client => client.getPaymentTransactions([HASH_A])]
  ])('%s aborts with the typed deadline error', async (label, call) => {
    const t = hangingTransport()
    const client = makeClient(t, { timeoutMs: 10 })
    const err = await call(client).catch(e => e)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].signal.reason).toBeInstanceOf(daemon.DaemonTimeoutError)
    expect(err).toBeInstanceOf(daemon.DaemonTimeoutError)
    expect(err.name).toBe('DaemonTimeoutError')
    expect(err.code).toBe('DAEMON_TIMEOUT')
  })

  function listen (server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  }

  test('the real node transport destroys a hung request with the typed deadline reason', async () => {
    const server = http.createServer(() => {}) // accept and never respond
    const port = await listen(server)
    try {
      const client = daemon.createDaemonClient({ daemonUrl: `http://127.0.0.1:${port}`, timeoutMs: 25 })
      const err = await client.getTransactions([HASH_A]).catch(e => e)
      expect(err).toBeInstanceOf(daemon.DaemonTimeoutError)
      expect(err.code).toBe('DAEMON_TIMEOUT')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  test('the real node transport destroys an already-aborted request with the signal reason', async () => {
    const server = http.createServer(() => {})
    const port = await listen(server)
    const RealAbortController = global.AbortController
    try {
      const deadline = new daemon.DaemonTimeoutError()
      // Simulate the race where the deadline fires before the transport binds
      // its abort listener: the signal arrives already aborted, carrying the
      // typed reason.
      global.AbortController = class {
        constructor () {
          this.signal = { aborted: true, reason: deadline, addEventListener () {} }
        }

        abort () {}
      }
      const client = daemon.createDaemonClient({ daemonUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 })
      const err = await client.getTransactions([HASH_A]).catch(e => e)
      expect(err).toBe(deadline)
    } finally {
      global.AbortController = RealAbortController
      await new Promise(resolve => server.close(resolve))
    }
  })
})
