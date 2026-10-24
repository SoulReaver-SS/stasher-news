/* eslint-env jest */

// Security regression coverage for scripts/render-media-config.cjs — the
// renderer that turns the deployment's MEDIA_AWS_* credentials into the
// SeaweedFS s3.config.json. The failure modes pinned here are the ones that
// would matter in production: secrets leaking into output/errors, invalid
// JSON from unescaped credentials, a silently anonymous store, and a
// world-readable config file.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildConfig, writeConfig } = require('../../scripts/render-media-config.cjs')

const VALID_ENV = {
  MEDIA_AWS_ACCESS_KEY_ID: 'media-root-key',
  MEDIA_AWS_SECRET_ACCESS_KEY: 'media-root-secret',
  NEXT_PUBLIC_AWS_UPLOAD_BUCKET: 'uploads'
}

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'render-media-config.cjs')

describe('buildConfig', () => {
  test('escapes JSON-special characters in credentials without corrupting the file', () => {
    const env = {
      MEDIA_AWS_ACCESS_KEY_ID: 'key"with\\backslash',
      MEDIA_AWS_SECRET_ACCESS_KEY: 'secret\nwith"quotes\tand\\slashes',
      NEXT_PUBLIC_AWS_UPLOAD_BUCKET: 'uploads'
    }
    const config = buildConfig(env)
    // JSON.stringify handles escaping; parse the serialization back to prove it
    const roundtrip = JSON.parse(JSON.stringify(config))
    expect(roundtrip.identities[0].credentials[0].accessKey).toBe(env.MEDIA_AWS_ACCESS_KEY_ID)
    expect(roundtrip.identities[0].credentials[0].secretKey).toBe(env.MEDIA_AWS_SECRET_ACCESS_KEY)
  })

  test('admin identity carries the exact full-action set', () => {
    const config = buildConfig(VALID_ENV)
    expect(config.identities[0].name).toBe('admin')
    expect(config.identities[0].actions).toEqual(['Admin', 'Read', 'Write', 'List', 'Tagging'])
  })

  test('anonymous identity is bucket-scoped Read only — never global Read or List', () => {
    const config = buildConfig({ ...VALID_ENV, NEXT_PUBLIC_AWS_UPLOAD_BUCKET: 'snuploads' })
    expect(config.identities[1]).toEqual({ name: 'anonymous', actions: ['Read:snuploads'] })
  })

  test('missing or half-set credentials throw', () => {
    expect(() => buildConfig({})).toThrow()
    expect(() => buildConfig({ ...VALID_ENV, MEDIA_AWS_SECRET_ACCESS_KEY: '' })).toThrow()
    expect(() => buildConfig({ ...VALID_ENV, MEDIA_AWS_ACCESS_KEY_ID: '' })).toThrow()
  })

  test('invalid bucket names throw (wildcard, path traversal, uppercase, bad chars)', () => {
    for (const bucket of ['', '*', 'up/loads', '../uploads', 'Uploads', 'up loads', 'uploads$', 'a'.repeat(64)]) {
      expect(() => buildConfig({ ...VALID_ENV, NEXT_PUBLIC_AWS_UPLOAD_BUCKET: bucket })).toThrow()
    }
  })

  test('accepts valid S3 bucket names (dots, dashes, 63-char)', () => {
    for (const bucket of ['uploads', 'sn-uploads.2026', 'a'.repeat(63)]) {
      expect(() => buildConfig({ ...VALID_ENV, NEXT_PUBLIC_AWS_UPLOAD_BUCKET: bucket })).not.toThrow()
    }
  })
})

describe('writeConfig', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-config-test-'))
    fs.chmodSync(dir, 0o700)
  })
  afterEach(() => {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('writes complete JSON with owner-only file mode', () => {
    const dest = path.join(dir, 's3.config.json')
    writeConfig(dest, buildConfig(VALID_ENV))
    const mode = fs.statSync(dest).mode & 0o777
    expect(mode).toBe(0o600)
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'))
    expect(parsed.identities).toHaveLength(2)
    expect(parsed.identities[0].credentials[0].secretKey).toBe(VALID_ENV.MEDIA_AWS_SECRET_ACCESS_KEY)
  })

  test('overwrites an existing file via atomic rename (no clobber of readers)', () => {
    const dest = path.join(dir, 's3.config.json')
    fs.writeFileSync(dest, 'old', { mode: 0o600 })
    writeConfig(dest, buildConfig(VALID_ENV))
    expect(JSON.parse(fs.readFileSync(dest, 'utf8')).identities[0].name).toBe('admin')
  })

  test('refuses an unprotected destination directory', () => {
    fs.chmodSync(dir, 0o755)
    try {
      expect(() => writeConfig(path.join(dir, 's3.config.json'), buildConfig(VALID_ENV))).toThrow()
    } finally {
      fs.chmodSync(dir, 0o700)
    }
    expect(fs.readdirSync(dir)).toEqual([])
  })

  test('cleans up its temporary file when serialization fails', () => {
    const dest = path.join(dir, 's3.config.json')
    // BigInt survives buildConfig validation-free path: serialize throws
    const bad = { identities: [{ name: 'x', actions: [1n] }] }
    expect(() => writeConfig(dest, bad)).toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('CLI', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-config-cli-'))
    fs.chmodSync(dir, 0o700)
  })
  afterEach(() => {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function runCli (env) {
    return execFileSync(process.execPath, [SCRIPT, path.join(dir, 's3.config.json')], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString()
  }

  test('writes valid config from env', () => {
    const stdout = runCli(VALID_ENV)
    expect(stdout).not.toContain('media-root-secret')
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 's3.config.json'), 'utf8'))
    expect(parsed.identities[1].actions).toEqual(['Read:uploads'])
  })

  test('fails closed with generic errors that never echo supplied values', () => {
    const cases = [
      { MEDIA_AWS_ACCESS_KEY_ID: 'leaky-key' },
      { MEDIA_AWS_ACCESS_KEY_ID: 'k', MEDIA_AWS_SECRET_ACCESS_KEY: 'leaky-secret' },
      { ...VALID_ENV, NEXT_PUBLIC_AWS_UPLOAD_BUCKET: 'bad bucket!' }
    ]
    for (const env of cases) {
      expect(() => runCli(env)).toThrow(/media_aws_|bucket/i)
      try {
        runCli(env)
      } catch (e) {
        const output = `${e.stderr || ''}${e.stdout || ''}`
        expect(output).not.toMatch(/leaky-key|leaky-secret|bad bucket!/)
      }
      expect(fs.readdirSync(dir)).toEqual([])
    }
  })
})
