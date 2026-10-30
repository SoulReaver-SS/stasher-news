import { signIn } from 'next-auth/react'
import styles from './login.module.css'
import { Form, Input, SubmitButton } from '@/components/form'
import { useState, useEffect, useMemo } from 'react'
import Alert from 'react-bootstrap/Alert'
import { useRouter } from 'next/router'
import { NostrAuthWithExplainer } from './nostr-auth'
import LoginButton, { LoginWithNymButton } from './login-button'
import { emailSchema } from '@/lib/validate'
import { OverlayTrigger, Tooltip } from 'react-bootstrap'
import Button from 'react-bootstrap/Button'
import * as cookie from 'cookie'
import { cookieOptions, MULTI_AUTH_ANON, MULTI_AUTH_POINTER } from '@/lib/auth'
import Link from 'next/link'
import useCookie from './use-cookie'
import { AccountChooser } from './account'
import PhraseLoginForm from './phrase-login-form'
import { COPY } from '@/lib/rebrand-copy'

export function EmailLoginForm ({ text, callbackUrl, multiAuth }) {
  return (
    <Form
      initial={{
        email: ''
      }}
      schema={emailSchema}
      onSubmit={async ({ email }) => {
        window.sessionStorage.setItem('callback', JSON.stringify({ email, callbackUrl }))
        signIn('email', { email, callbackUrl, multiAuth })
      }}
    >
      <Input
        label='Email'
        name='email'
        placeholder='email@example.com'
        required
        autoFocus
      />
      <SubmitButton variant='outline-primary' className={styles.providerButton}>{text || 'Login'} with Email</SubmitButton>
    </Form>
  )
}

const authErrorMessages = {
  OAuthSignin: 'Error constructing OAuth URL. Try again or choose a different method.',
  OAuthCallback: 'Error handling OAuth response. Try again or choose a different method.',
  OAuthCreateAccount: 'Could not create OAuth account. Try again or choose a different method.',
  EmailCreateAccount: 'Could not create Email account. Try again or choose a different method.',
  Callback: 'Could not authenticate. Try again or choose a different method.',
  OAuthAccountNotLinked: 'This auth method is linked to another account. To link to this account first unlink the other account.',
  EmailSignin: 'Failed to send email. Make sure you entered your email address correctly.',
  CredentialsSignin: 'Could not authenticate. Try again or choose a different method.',
  // thrown by pubkeyAuth when the signature is valid but no account claims
  // the phrase/nostr key in login mode (phrase space is unenumerable, so no
  // anti-enumeration theater)
  PhraseNoAccount: 'no account matches this phrase. sign up first?',
  NostrNoAccount: 'no account matches this key.',
  default: 'Auth failed. Try again or choose a different method.'
}

export function authErrorMessage (error, signin) {
  if (!error) return null

  const message = error && (authErrorMessages[error] ?? authErrorMessages.default)
  // workaround for signin/signup awareness due to missing support from next-auth
  if (signin) {
    return (
      <>
        {message}
        <br />
        If you are new to Stasher News, please <Link className='fw-bold' href='/signup'>sign up</Link> first.
      </>
    )
  }

  return message
}

const multiAuthProviders = ['Nostr', 'Phrase', 'Email']

export default function Login ({ providers, callbackUrl, multiAuth, error, text, Header, Footer, signin, domainData }) {
  const [errorMessage, setErrorMessage] = useState(authErrorMessage(error, signin))
  const router = useRouter()
  const [, setPointerCookie] = useCookie(MULTI_AUTH_POINTER)

  // we can't signup if we're already logged in to another account
  // for custom-domain signups, we first need to switch to anon.
  useEffect(() => {
    if (!signin && domainData) {
      setPointerCookie(MULTI_AUTH_ANON, cookieOptions({ httpOnly: false }))
    }
  }, [signin, domainData, setPointerCookie])

  multiAuth = typeof multiAuth === 'string' ? multiAuth === 'true' : !!multiAuth

  // signup/signin awareness cookie
  useEffect(() => {
    // clear the cookie if we're on /signup instead of /login
    // since the server will only check if the cookie is set, not its value
    const options = cookieOptions({ httpOnly: false, maxAge: signin ? 86400 : 0 })
    document.cookie = cookie.serialize('signin', signin, options)
  }, [signin])

  const sortedProviders = useMemo(() =>
    // email first
    Object.values(providers || {})
      .sort((a, b) => a.name === 'Email' ? -1 : b.name === 'Email' ? 1 : 0)
      .filter(provider => multiAuth ? multiAuthProviders.includes(provider.name) : true),
  [providers, multiAuth])

  const nostrEnabled = Object.values(providers || {}).some(p => p.id === 'nostr')
  const phraseEnabled = Object.values(providers || {}).some(p => p.id === 'phrase')

  if (router.query.type === 'nostr' && nostrEnabled) {
    return <NostrAuthWithExplainer callbackUrl={callbackUrl} text={text} multiAuth={multiAuth} />
  }

  if (router.query.type === 'phrase' && phraseEnabled) {
    return (
      <div className={styles.login}>
        {Header && <Header />}
        {errorMessage &&
          <Alert variant='danger' onClose={() => setErrorMessage(undefined)} dismissible>{errorMessage}</Alert>}
        <PhraseLoginForm callbackUrl={callbackUrl} multiAuth={multiAuth} />
        {Footer && <Footer />}
      </div>
    )
  }

  return (
    <div className={styles.login}>
      {Header && <Header />}
      {errorMessage &&
        <Alert
          variant='danger'
          onClose={() => setErrorMessage(undefined)}
          dismissible
        >{errorMessage}
        </Alert>}
      {/** custom domain auth sync button */}
      {domainData && (
        <LoginWithNymButton
          className={styles.providerButton}
          callbackUrl={callbackUrl}
        />
      )}
      {signin && !multiAuth && !domainData && <AccountChooser />}
      {sortedProviders.map(provider => {
        switch (provider.name) {
          case 'Email':
            return (
              <div className='w-100' key={provider.id}>
                <EmailLoginForm text={text} callbackUrl={callbackUrl} multiAuth={multiAuth} />
                <div className='my-3 mt-4 text-center text-muted fw-bold'>or</div>
              </div>
            )
          case 'Slashtags':
          case 'Nostr':
            return (
              <LoginButton
                className={`mt-2 ${styles.providerButton}`}
                key={provider.id}
                type={provider.id.toLowerCase()}
                onClick={() => {
                  const { nodata, ...query } = router.query
                  router.push({
                    pathname: router.pathname,
                    query: { ...query, type: provider.name.toLowerCase() }
                  })
                }}
                text={`${text || 'Login'} with`}
              />
            )
          case 'Phrase':
            return (
              <Button
                key={provider.id}
                className={`mt-2 ${styles.providerButton}`}
                variant='outline-primary'
                onClick={() => {
                  if (signin) {
                    const { nodata, ...query } = router.query
                    router.push({ pathname: router.pathname, query: { ...query, type: 'phrase' } })
                  } else {
                    router.push({ pathname: '/signup/phrase', query: { callbackUrl } })
                  }
                }}
              >{signin ? COPY.phraseLoginButton : COPY.phraseSignupButton}
              </Button>
            )
          default:
            return (
              <OverlayTrigger
                key={provider.id}
                placement='bottom'
                overlay={multiAuth ? <Tooltip>not available for account switching yet</Tooltip> : <></>}
                trigger={['hover', 'focus']}
              >
                <div className='w-100'>
                  <LoginButton
                    className={`mt-2 ${styles.providerButton}`}
                    type={provider.id.toLowerCase()}
                    onClick={() => signIn(provider.id, { callbackUrl, multiAuth })}
                    text={`${text || 'Login'} with`}
                    disabled={multiAuth}
                  />
                </div>
              </OverlayTrigger>
            )
        }
      })}
      {Footer && <Footer />}
    </div>
  )
}
