/* eslint-env jest */

// The SeaweedFS backend entrypoint must fail closed on a config that cannot
// authenticate anything — before staging it or starting the server. The
// demonstrated failure (review 2026-10-24): a hand-written `{}` config passes
// the old nonempty check, boots "healthy", and denies every operation. These
// tests run the real entrypoint script with CONFIG_SRC/CONFIG_DST pointed at
// a temp dir; a PASSING validation is proven by the script getting PAST
// validation (it then fails at a later root-only stage with a different
// error), so each assertion distinguishes which gate fired.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ENTRYPOINT = path.join(__dirname, '..', '..', 'docker', 'seaweedfs', 'entrypoint.sh')

let srcDir
let dstDir

beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-entry-src-'))
  dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-entry-dst-'))
  fs.chmodSync(dstDir, 0o700)
})

afterEach(() => {
  fs.rmSync(srcDir, { recursive: true, force: true })
  fs.rmSync(dstDir, { recursive: true, force: true })
})

function run () {
  return execFileSync('sh', [ENTRYPOINT], {
    env: {
      ...process.env,
      CONFIG_SRC: path.join(srcDir, 's3.config.json'),
      CONFIG_DST: path.join(dstDir, 's3.config.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

function writeConfig (content) {
  fs.writeFileSync(path.join(srcDir, 's3.config.json'), content)
}

const VALID_CONFIG = JSON.stringify({
  identities: [
    { name: 'admin', credentials: [{ accessKey: 'k', secretKey: 's' }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] },
    { name: 'anonymous', actions: ['Read:uploads'] }
  ]
})

describe('seaweedfs entrypoint config gate', () => {
  test('missing config file → generic failure at the config gate', () => {
    expect(() => run()).toThrow(/config missing or empty/)
  })

  test('empty config file → generic failure at the config gate', () => {
    writeConfig('')
    expect(() => run()).toThrow(/config missing or empty/)
  })

  test('identity-less config ({}) → rejected before staging', () => {
    writeConfig('{}')
    try {
      run()
      throw new Error('entrypoint should have failed')
    } catch (e) {
      expect(e.stderr.toString()).toContain('config missing required identities')
      // prove the failure happened at the CONFIG gate, not a later stage
      expect(e.stderr.toString()).not.toContain('permission')
      expect(fs.readdirSync(dstDir)).toEqual([])
    }
  })

  test('identities without credentials → rejected before staging', () => {
    writeConfig(JSON.stringify({ identities: [{ name: 'anonymous', actions: ['Read:uploads'] }] }))
    expect(() => run()).toThrow(/config missing required identities/)
    expect(fs.readdirSync(dstDir)).toEqual([])
  })

  test('credentials without an anonymous identity → rejected before staging', () => {
    writeConfig(JSON.stringify({ identities: [{ name: 'admin', credentials: [{ accessKey: 'k', secretKey: 's' }] }] }))
    expect(() => run()).toThrow(/config missing the anonymous identity/)
    expect(fs.readdirSync(dstDir)).toEqual([])
  })

  test('renderer-shaped config passes the gate (fails later, at a root-only stage)', () => {
    writeConfig(VALID_CONFIG)
    try {
      run()
      throw new Error('entrypoint should not have fully run as non-root')
    } catch (e) {
      // got past validation: the failure is install/exec (root-only stages),
      // never the config message
      expect(e.stderr).not.toContain('config missing')
      expect(e.stderr).not.toContain('config missing or empty')
    }
  })
})
