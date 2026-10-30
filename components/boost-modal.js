import Button from 'react-bootstrap/Button'
import BootstrapForm from 'react-bootstrap/Form'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { gql } from '@apollo/client'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import AccordianItem from './accordian-item'
import MoneroPaymentView from './monero-payment-view'
import PaymentSuccessView from './payment-success-view'
import { useAct } from './item-act'
import { useAnimation } from './animation'
import { useToast } from './toast'
import { useMe } from './me'
import { canUseBoostCreditOnItem } from '@/lib/boost-credit'
import { BOOST_CREDIT_PICONEROS } from '@/lib/quests'
import { piconerosToMXmr, piconerosToMXmrDual, piconerosToXmr, xmrToPiconeros } from '@/lib/format'
import { BOOST_MIN } from '@/lib/constants'
import BoostIcon from '@/svgs/arrow-up-double-line.svg'
import MXmrHint from './mxmr-hint'

const PRESETS = ['0.001', '0.01', '0.1', '1']

const BOOST_POLL_MS = 5000

// browsers clamp timer delays at Math.pow(2, 31) - 1 ms; schedule just inside
// that ceiling so an expiry far in the future reschedules instead of firing late
const MAX_TIMER_MS = 2 ** 31 - 5

// Minimal explicit Item selection for the redemption response: Apollo merges
// the normalized result into the Item:id cache entity by field, so selecting
// only the fields we claim (never applying every cached ItemFieldType) keeps the
// write small and safe. The paid path keeps its own FeeObservation poll.
export const USE_BOOST_CREDIT_MUTATION = gql`
  mutation useBoostCredit($itemId: ID!, $rewardId: ID!) {
    useBoostCredit(itemId: $itemId, rewardId: $rewardId) {
      id
      promoBoostPiconeros
      status
      feeStatus
    }
  }`

const PAY_IN_QUERY = gql`
  query PayIn($id: Int!) {
    payIn(id: $id) {
      id
      feeObserved
    }
  }
`

export const BOOST_CREDIT_SUCCESS_TITLE = 'boost credit applied'
export const PROMO_RANKING_DISCLAIMER = 'promotional ranking only; no XMR payment and no rewards-pool contribution'

// Pure credit-availability predicate for the modal's offer: one unconsumed,
// unexpired credit, and the item must be the viewer's own eligible live post.
// `now` is passed in so expiry can be re-checked against the modal's clock.
export const isCreditUsable = (item, me, now) => {
  if (!item || !me) return false
  const creditId = me?.privates?.boostCreditId
  const expiresAt = me?.privates?.boostCreditExpiresAt
  return creditId != null && Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > now && canUseBoostCreditOnItem(item, me?.id)
}

// Pure expiry-timer delay: milliseconds until the credit expires, clamped to
// the maximum browser timer delay, or null when it is already gone/invalid.
export const creditExpiryTimeoutMs = (expiresAt, now) => {
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) return null
  return Math.min(expiry - now, MAX_TIMER_MS)
}

// a server response with GraphQL errors is a definitive rejection (nothing
// committed); anything else (network drop, timeout) leaves the outcome unknown
const serverRejected = (error) => Array.isArray(error?.errors) && error.errors.length > 0

export default function BoostModal ({ item, onClose }) {
  const actor = useAct()
  const toaster = useToast()
  const animate = useAnimation()
  const client = useApolloClient()
  const { me, refreshMe } = useMe()
  const [amount, setAmount] = useState('0.001')
  const [piconeros, setPiconeros] = useState(null)
  const [moneroUri, setMoneroUri] = useState(null)
  const [payInId, setPayInId] = useState(null)
  const [boostPaid, setBoostPaid] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [creditApplied, setCreditApplied] = useState(false)

  // the redemption an earlier attempt may have consumed without this client
  // ever seeing the response: only an explicit retry re-uses that exact id —
  // a refreshed ME must never silently swap in a newly earned credit
  const lostCreditRef = useRef(null)
  const [lostCredit, setLostCredit] = useState(null)

  // synchronous in-flight guard shared by BOTH paths: React state alone cannot
  // absorb rapid duplicate clicks arriving inside one commit
  const submittingRef = useRef(false)

  const setLostCreditLocked = (value) => {
    lostCreditRef.current = value
    setLostCredit(value)
  }

  const [redeemCredit] = useMutation(USE_BOOST_CREDIT_MUTATION)

  // credits can expire while the modal sits open: refresh ME when it opens
  // (the page-level poll does not refetch on modal open on its own)
  useEffect(() => {
    refreshMe?.()?.catch?.(() => {})
  }, [refreshMe])

  // re-read the clock when the tab regains visibility/focus, and schedule one
  // clamped timer per computed delay so a future expiry hides the offer on
  // its own; both the timer and the listeners are cleaned up on close/unmount
  useEffect(() => {
    const updateNow = () => setNow(Date.now())
    document.addEventListener('visibilitychange', updateNow)
    window.addEventListener('focus', updateNow)
    return () => {
      document.removeEventListener('visibilitychange', updateNow)
      window.removeEventListener('focus', updateNow)
    }
  }, [])

  const expiresAt = me?.privates?.boostCreditExpiresAt

  // one clamped timer per computed delay: a future expiry hides the offer on
  // its own; visibilitychange/focus above re-loop it after background stalls
  useEffect(() => {
    const ms = creditExpiryTimeoutMs(expiresAt, now)
    if (ms == null) return
    const timer = setTimeout(() => setNow(Date.now()), ms)
    return () => clearTimeout(timer)
  }, [expiresAt, now])

  const onSubmit = useCallback(async (e) => {
    e?.preventDefault?.()
    // the act mutation validates piconeros as an integer (actSchema boostValidator),
    // so convert the decimal XMR input to piconeros before sending (mirrors item-act.js)
    let piconeros
    try {
      piconeros = Number(xmrToPiconeros(String(amount)))
    } catch {
      toaster.danger('enter a valid XMR amount (min 0.001)')
      return
    }
    if (piconeros < BOOST_MIN) {
      toaster.danger(`boost must be at least ${piconerosToXmr(BigInt(BOOST_MIN))}`)
      return
    }
    if (submittingRef.current || lostCreditRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const res = await actor({ variables: { id: item.id, piconeros, act: 'BOOST' } })
      const uri = res?.data?.act?.moneroUri
      const id = res?.data?.act?.id
      if (!uri) {
        throw new Error('boost did not return a payment URI')
      }
      setPiconeros(piconeros)
      setMoneroUri(uri)
      setPayInId(id)
    } catch (error) {
      toaster.danger(error.message || 'failed to boost item')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [actor, item.id, amount, toaster])

  // shared credit submission; called with the exact reward id captured BEFORE
  // any await so a ME refresh landing mid-request cannot change it
  const submitCredit = useCallback(async (rewardId) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await redeemCredit({ variables: { itemId: item.id, rewardId } })
      setLostCreditLocked(null)
      setCreditApplied(true)
      animate()
      // the committed redemption is reported as applied even if the refresh
      // itself fails; Apollo already merged the returned Item into the cache,
      // so rank ordering and ME state are pushed fresh instead
      refreshMe?.()?.catch?.(() => {})
      client?.refetchQueries?.({ include: 'active' })?.catch?.(() => {})
    } catch (error) {
      const message = error.message || 'boost credit unavailable'
      if (serverRejected(error)) {
        // server answered: its rejection is authoritative and the credit was
        // not consumed — drop the offer, keep the paid amount form intact
        toaster.danger(message)
        refreshMe?.()?.catch?.(() => {})
      } else {
        // no server verdict: the redemption may still have committed. lock new
        // credit and paid submissions behind an explicit retry of THIS id
        // (refresh ME so the offer reflects state, but never auto-substitute)
        setLostCreditLocked({ rewardId, message })
        refreshMe?.()?.catch?.(() => {})
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [redeemCredit, item.id, animate, refreshMe, client, toaster])

  const onUseCredit = useCallback(async () => {
    if (submittingRef.current || lostCreditRef.current) return
    // re-check eligibility at click time (the offer may be stale); the server
    // remains authoritative either way
    const creditId = me?.privates?.boostCreditId
    if (creditId == null || !isCreditUsable(item, me, Date.now())) {
      refreshMe?.()?.catch?.(() => {})
      return
    }
    await submitCredit(creditId)
  }, [me, item, submitCredit, refreshMe])

  const onRetryCredit = useCallback(async () => {
    if (submittingRef.current) return
    const rewardId = lostCreditRef.current?.rewardId
    if (rewardId == null) return
    await submitCredit(rewardId)
  }, [submitCredit])

  // Poll the PayIn's feeObserved flag: the rewardsWalletObserver records the
  // FeeObservation('BOOST') once the payment lands on-chain. The credit path
  // never sets payInId, so this poll stays skipped for credits.
  const { data } = useQuery(PAY_IN_QUERY, {
    variables: { id: payInId },
    skip: !payInId || boostPaid,
    pollInterval: BOOST_POLL_MS
  })
  const observed = data?.payIn?.feeObserved === true

  useEffect(() => {
    if (!observed || boostPaid) return
    setBoostPaid(true)
    animate()
  }, [observed, boostPaid, animate])

  if (boostPaid) {
    return (
      <PaymentSuccessView
        title='Payment detected — your boost is on its way!'
        autoCloseMs={1500}
        onAutoClose={onClose}
      />
    )
  }

  if (creditApplied) {
    return (
      <PaymentSuccessView
        title={BOOST_CREDIT_SUCCESS_TITLE}
        note={PROMO_RANKING_DISCLAIMER}
        autoCloseMs={1500}
        onAutoClose={onClose}
      />
    )
  }

  return (
    <div className='p-3'>
      <h5 className='fw-bold text-center'>boost this item</h5>
      {!moneroUri
        ? (
          <BootstrapForm onSubmit={onSubmit}>
            {lostCredit &&
              (
                <div className='border rounded p-2 mb-3'>
                  <p className='mb-2 text-warning'>
                    <small>
                      no confirmation for your boost credit — the redemption may still have gone through.
                      new credits and paid boosts stay locked until this exact attempt is retried.
                    </small>
                  </p>
                  <Button variant='warning' type='button' disabled={submitting} onClick={onRetryCredit}>
                    retry boost credit
                  </Button>
                </div>
              )}
            {isCreditUsable(item, me, now) && !lostCredit &&
              (
                <div className='border rounded p-2 mb-3'>
                  <div className='fw-bold'>
                    boost credit
                  </div>
                  <div>
                    worth {piconerosToMXmr(BigInt(BOOST_CREDIT_PICONEROS))}, expires {new Date(expiresAt).toLocaleString()}
                  </div>
                  <div className='text-muted'><small>{PROMO_RANKING_DISCLAIMER}</small></div>
                  <Button variant='success' type='button' disabled={submitting} onClick={onUseCredit} className='mt-2'>
                    use boost credit
                  </Button>
                </div>
              )}
            <div className='d-flex gap-2 justify-content-center mb-2 flex-wrap'>
              {PRESETS.map(num =>
                <Button size='sm' key={num} onClick={() => setAmount(num)}>{piconerosToMXmr(xmrToPiconeros(num))}</Button>)}
            </div>
            <BootstrapForm.Group>
              <BootstrapForm.Control
                type='text'
                inputMode='decimal'
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder='XMR amount'
              />
              <MXmrHint value={amount} />
            </BootstrapForm.Group>
            <div className='d-flex justify-content-end gap-2 mt-3'>
              <Button variant='secondary' onClick={onClose}>cancel</Button>
              <Button type='submit' disabled={submitting || !!lostCredit}>
                <BoostIcon width={16} height={16} className='me-1' />boost
              </Button>
            </div>
          </BootstrapForm>
          )
        : (
          <MoneroPaymentView
            moneroUri={moneroUri}
            amountPiconeros={BigInt(piconeros)}
            heading='Pay this boost'
            description={`Scan to send ${piconerosToMXmrDual(BigInt(piconeros))} to the platform wallet. 30% funds the weekly curator rewards.`}
          >
            <p className='text-muted text-center mt-3'>
              <small>
                Boost ranks this item higher like a tip. Detection takes about one block; final confirmation takes a few more.
              </small>
            </p>
          </MoneroPaymentView>
          )}
      <AccordianItem header='what is boost?' body={<BoostHelp />} />
    </div>
  )
}

export function BoostHelp () {
  return (
    <ol>
      <li>Boost is <strong>exactly</strong> like a tip from other stashers: it ranks the item higher based on the amount</li>
      <li>30% of boost funds the weekly curator rewards, 70% supports the platform</li>
      <li>Boosted items can be downvoted to reduce their rank</li>
      <li>
        A quest boost credit buys paid-boost ranking on your own live post without
        sending XMR: {PROMO_RANKING_DISCLAIMER}, and it expires
      </li>
    </ol>
  )
}
