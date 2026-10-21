import Card from 'react-bootstrap/Card'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Link from 'next/link'
import { Form, Input, SubmitButton, CopyButton } from '@/components/form'
import { gql } from '@apollo/client'
import { useMutation, useQuery } from '@apollo/client/react'
import { useToast } from '@/components/toast'
import { useShowModal } from '@/components/modal'
import { ObstacleButtons } from '@/components/obstacle'
import Qr from '@/components/qr'

// StasherNews author wallet onboarding (spec §8.2). Post-pivot there is one
// detection model: paste primary address + view key, register with lws, tips
// are detected via webhooks. Model B (manual proof) is deferred indefinitely.

const MY_MONERO_ACCOUNT = gql`
  query MyMoneroAccount {
    myMoneroAccount { id address label privacyMode }
  }
`
const REGISTER_MONERO_ACCOUNT_MUTATION = gql`
  mutation RegisterMoneroAccount($address: String!, $viewKey: String!) {
    registerMoneroAccount(address: $address, viewKey: $viewKey) {
      id address label privacyMode
    }
  }
`
const UNREGISTER_MONERO_ACCOUNT_MUTATION = gql`
  mutation UnregisterMoneroAccount {
    unregisterMoneroAccount
  }
`

function networkName () {
  return (process.env.NEXT_PUBLIC_MONERO_NETWORK || 'stagenet').toLowerCase()
}
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/
function heuristicCheckAddress (address) {
  if (!address) return 'required'
  // 106 chars = integrated address (payment id embedded) — instant feedback
  // for the exact class monero-lws rejects; subaddresses (95 chars) can't be
  // distinguished from primaries client-side, the server screens those.
  if (address.length === 106) return 'this is an integrated address (payment id embedded), use your wallet\'s primary address'
  if (address.length < 90 || address.length > 110) return 'address looks truncated or malformed'
  if (!BASE58.test(address)) return 'address contains invalid characters'
  return null
}
function heuristicCheckViewKey (viewKey) {
  if (!viewKey) return 'required'
  if (!/^[0-9a-fA-F]{64}$/.test(viewKey)) return 'view key must be 64 hex characters'
  return null
}

// Rendered client-side only (ssr: false): the SSR render client is cache-only
// and can never resolve this orphan query, so running it on the server would
// render the wizard in the initial HTML for users WITH a wallet — a hydration
// mismatch when the client then loads. see wallet-warning.js for the same fix.
export default function WalletSetup () {
  const { data, loading, error } = useQuery(MY_MONERO_ACCOUNT, { ssr: false })
  if (loading) return <div className='text-muted'>loading wallet…</div>
  if (error) return <Alert variant='danger'>failed to load wallet status: {error.message}</Alert>
  const account = data?.myMoneroAccount
  if (account) return <ExistingAccount account={account} />
  return <WalletWizard />
}

function RemoveWalletObstacle ({ onClose, onConfirm }) {
  return (
    <div className='text-center'>
      <h4 className='mb-3'>remove your wallet?</h4>
      <p className='text-muted small'>
        stasher news will stop scanning this wallet for incoming tips. any tip
        already sent to this wallet that has not yet been detected will not be
        credited. your post and tip history is kept.
      </p>
      <ObstacleButtons
        onClose={onClose}
        onConfirm={onConfirm}
        confirmText='remove'
        confirmVariant='danger'
      />
    </div>
  )
}

function ExistingAccount ({ account }) {
  const toaster = useToast()
  const showModal = useShowModal()
  const [unregister, { loading }] = useMutation(UNREGISTER_MONERO_ACCOUNT_MUTATION, {
    update (cache) {
      cache.writeQuery({ query: MY_MONERO_ACCOUNT, data: { myMoneroAccount: null } })
    }
  })

  const handleRemove = () => {
    showModal(onClose => (
      <RemoveWalletObstacle
        onClose={onClose}
        onConfirm={async () => {
          try {
            await unregister()
            toaster.success('wallet removed')
          } catch (err) {
            toaster.danger(err.message)
          } finally {
            onClose()
          }
        }}
      />
    ))
  }

  return (
    <Card>
      <Card.Body>
        <h4 className='mb-2'>wallet registered</h4>
        <p className='text-muted'>
          your wallet is under indexer observation. tips sent to your posts are
          detected automatically via webhooks and credited when confirmed. tips
          are 100% peer-to-peer. Stasher News never holds your funds.
        </p>
        <Input
          label='primary address' name='addressDisplay'
          placeholder={account.address} readOnly noForm groupClassName='mb-3'
          append={<CopyButton value={account.address} icon />}
        />
        <Button variant='danger' onClick={handleRemove} disabled={loading}>
          {loading ? 'removing…' : 'remove wallet'}
        </Button>
      </Card.Body>
    </Card>
  )
}

function WalletWizard () {
  const toaster = useToast()
  const [register, { loading }] = useMutation(REGISTER_MONERO_ACCOUNT_MUTATION, {
    update (cache, { data: { registerMoneroAccount } }) {
      cache.writeQuery({ query: MY_MONERO_ACCOUNT, data: { myMoneroAccount: registerMoneroAccount } })
    }
  })
  return (
    <>
      <WalletGuideCard />
      <Card className='mb-3'>
        <Card.Body>
          <h5 className='mb-2'>register your wallet</h5>
          <AddressConfirmBlock address='' />
          <Form
            initial={{ address: '', viewKey: '' }}
            validate={({ address, viewKey }) => {
              const errors = {}
              if (heuristicCheckAddress(address?.trim())) errors.address = 'required'
              if (heuristicCheckViewKey(viewKey?.trim())) errors.viewKey = 'required'
              return errors
            }}
            onSubmit={async ({ address, viewKey }) => {
              const addr = address.trim()
              const vk = viewKey.trim()
              const aErr = heuristicCheckAddress(addr)
              if (aErr) throw new Error(aErr)
              const vErr = heuristicCheckViewKey(vk)
              if (vErr) throw new Error(vErr)
              try {
                await register({ variables: { address: addr, viewKey: vk } })
                toaster.success('wallet registered with indexer')
              } catch (err) {
                throw new Error(err.message)
              }
            }}
          >
            <Input
              label={`primary monero address (${networkName()})`} name='address'
              placeholder='paste your wallet primary address' required autoFocus groupClassName='mb-3'
              hint={<small className='text-muted'>primary address only — integrated (payment id) and subaddress addresses are not supported.</small>}
            />
            <Input
              label='private view key' name='viewKey' type='password'
              placeholder='paste your wallet view key' required groupClassName='mb-3'
              hint={<small className='text-muted'>only lets us see incoming transfers — it cannot spend funds.</small>}
            />
            <SubmitButton variant='info' className='px-4' disabled={loading} submittingText='Registering with indexer…'>
              register
            </SubmitButton>
          </Form>
        </Card.Body>
      </Card>
    </>
  )
}

// Exported for the copy-pinning test (test/components/wallet-guide.test.js),
// same pattern as the rewards page's CuratorBudgetCopy.
export function WalletGuideCard () {
  return (
    <Card className='mb-3'>
      <Card.Body>
        <h5 className='mb-1'>need a monero wallet?</h5>
        <p className='text-muted small mb-2'>
          tips are 100% peer-to-peer — they go straight to your wallet. any of
          these work. use <strong>{networkName()}</strong> for this site.
        </p>
        <div className='d-flex gap-2 flex-wrap'>
          <Button variant='outline-info' size='sm' href='https://cakewallet.com' target='_blank' rel='noopener noreferrer'>cake wallet</Button>
          <Button variant='outline-info' size='sm' href='https://monerujo.io' target='_blank' rel='noopener noreferrer'>monerujo</Button>
          <Button variant='outline-info' size='sm' href='https://featherwallet.org' target='_blank' rel='noopener noreferrer'>feather wallet</Button>
        </div>
        <div className='mt-3'>
          <div className='text-muted small mb-1'>New to Monero?</div>
          <Link href='/items/339260' className='small'>
            start with this user-written guide to Monero wallets
          </Link>
        </div>
      </Card.Body>
    </Card>
  )
}

function AddressConfirmBlock ({ address }) {
  if (!address) return null
  return (
    <Card className='mb-3' border='light'>
      <Card.Body className='d-flex flex-column flex-md-row align-items-center gap-3'>
        <div style={{ minWidth: 200 }}>
          <div className='text-muted small mb-1'>your receiving address</div>
          <div className='d-flex align-items-center'>
            <code className='text-break' style={{ fontSize: '0.8rem' }}>{address.slice(0, 12)}…{address.slice(-8)}</code>
            <CopyButton value={address} icon />
          </div>
        </div>
        <div style={{ maxWidth: 180 }}>
          <Qr value={address} copy={false} description={<span className='small'>scan to verify address</span>} />
        </div>
      </Card.Body>
    </Card>
  )
}
