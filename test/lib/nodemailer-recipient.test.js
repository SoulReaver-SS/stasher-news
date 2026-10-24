/* eslint-env jest */

// Auth/security regression for the mail recipient parser (nodemailer
// addressparser): three GHSA-fixed misparses delivered attacker-chosen
// recipients from addresses a conformant RFC 5322 parser approves. The
// transport is offline (stream, buffered) — nothing reads LOGIN_EMAIL_SERVER
// and no SMTP connection is attempted.

const nodemailer = require('nodemailer')

const transport = () => nodemailer.createTransport({ streamTransport: true, buffer: true })
const message = to => ({ from: 'sender@example.com', to, subject: 'test', text: 'test' })

test.each([
  ['Victim (x(y) <evil@evil.com>) <v@victim.com>', 'victim.com'],
  ['G: (a; <evil@evil.com>) <v@victim.com>;', 'victim.com'],
  ['<"a@evil.com>"@good.com>', 'good.com']
])('preserves recipient domain for %s', async (input, domain) => {
  const info = await transport().sendMail(message(input))
  expect(info.envelope.to).toHaveLength(1)
  expect(info.envelope.to[0].slice(info.envelope.to[0].lastIndexOf('@') + 1)).toBe(domain)
})

test('ordinary plus-address works through the auth callback API', done => {
  transport().sendMail(message('User <user+tag@example.com>'), (error, info) => {
    try {
      expect(error).toBeNull()
      expect(info.envelope.to).toEqual(['user+tag@example.com'])
      expect(Buffer.isBuffer(info.message)).toBe(true)
      done()
    } catch (error) { done(error) }
  })
})
