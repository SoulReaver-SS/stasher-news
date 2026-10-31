/* eslint-env jest */
import { onionLocationFor } from '@/lib/onion'

const ONION = 'http://' + 'a'.repeat(52) + 'bcdd.onion'
const base = { onionUrl: ONION, host: 'stasher.news', mainUrl: 'https://stasher.news', pathname: '/items/42', search: '?commentId=7' }

describe('onionLocationFor', () => {
  test('maps the main site path and query onto the onion', () => {
    expect(onionLocationFor(base)).toBe(`${ONION}/items/42?commentId=7`)
    expect(onionLocationFor({ ...base, onionUrl: ONION + '/' })).toBe(`${ONION}/items/42?commentId=7`)
    expect(onionLocationFor({ ...base, host: 'Stasher.News' })).toBe(`${ONION}/items/42?commentId=7`)
  })

  test('off when ONION_URL is unset or not a v3 onion', () => {
    expect(onionLocationFor({ ...base, onionUrl: undefined })).toBeNull()
    expect(onionLocationFor({ ...base, onionUrl: 'http://short.onion' })).toBeNull()
    expect(onionLocationFor({ ...base, onionUrl: 'https://evil.example' })).toBeNull()
    expect(onionLocationFor({ ...base, onionUrl: ONION.replace('http://', 'https://') })).toBeNull()
  })

  test('never sent from other hosts (custom domains, the onion itself)', () => {
    expect(onionLocationFor({ ...base, host: 'my-turf.example' })).toBeNull()
    expect(onionLocationFor({ ...base, host: ONION.replace('http://', '') })).toBeNull()
    expect(onionLocationFor({ ...base, mainUrl: undefined })).toBeNull()
  })
})
