/* eslint-env jest */
const fs = require('node:fs')
const path = require('node:path')

const read = file => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('production imgproxy privacy configuration', () => {
  const caddy = read('docker/caddy/Caddyfile.prod')
  const media = caddy.match(/^media\.stasher\.news \{\r?\n([\s\S]*?)^\}/m)?.[1]
  const imgproxy = read('docker-compose.yml').match(
    /^  imgproxy:\r?\n([\s\S]*?)(?=^  [a-z][\w-]*:|(?![\s\S]))/m
  )?.[1]

  test.each(['X-Forwarded-For', 'CF-Connecting-IP', 'X-Real-IP'])(
    'media upstream deletes %s', header => {
      expect(media).toBeDefined()
      expect(media).toMatch(/reverse_proxy imgproxy:8080\s*\{/)
      expect(media).toMatch(new RegExp(`^\\s*header_up -${header}\\s*$`, 'm'))
      expect(media).not.toMatch(new RegExp(`^\\s*header_up ${header}\\s`, 'm'))
    }
  )

  test('app and capture retain their existing XFF handling', () => {
    expect(caddy.match(/header_up X-Forwarded-For \{remote_host\}/g)).toHaveLength(2)
  })

  test('imgproxy Docker logs have explicit service-local rotation', () => {
    expect(imgproxy).toBeDefined()
    expect(imgproxy).toMatch(/^    logging:\s*$/m)
    expect(imgproxy).toMatch(/^      driver: json-file\s*$/m)
    expect(imgproxy).toMatch(/^        max-size: "10m"\s*$/m)
    expect(imgproxy).toMatch(/^        max-file: "3"\s*$/m)
  })

  test('imgproxy port remains loopback-only', () => {
    expect(imgproxy).toContain('"127.0.0.1:3001:8080"')
    expect(imgproxy).not.toMatch(/^\s*- ["']?(?:0\.0\.0\.0:)?3001:8080/m)
  })
})

describe('production media hostname consistency', () => {
  const productionEnv = read('.env.production')
  const newsletter = read('scripts/newsletter.js')

  test('production build default uses the live Caddy media hostname', () => {
    expect(productionEnv).toMatch(
      /^NEXT_PUBLIC_IMGPROXY_URL=https:\/\/media\.stasher\.news\/\r?$/m
    )
    expect(productionEnv).not.toContain('imgprxy.stasher.news')
  })

  test('legacy newsletter resolves relative image paths against the live hostname', () => {
    expect(newsletter).toContain(
      "new URL(topMeme?.winner.image, 'https://media.stasher.news').href"
    )
    expect(newsletter).not.toContain('imgprxy.stasher.news')
  })
})
