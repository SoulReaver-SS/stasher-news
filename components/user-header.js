import Button from 'react-bootstrap/Button'
import InputGroup from 'react-bootstrap/InputGroup'
import Image from 'react-bootstrap/Image'
import Link from 'next/link'
import { useRouter } from 'next/router'
import Nav from 'react-bootstrap/Nav'
import { useState, useEffect } from 'react'
import { Form, Input, SubmitButton } from './form'
import { gql } from '@apollo/client'
import { useApolloClient, useMutation } from '@apollo/client/react'
import styles from './user-header.module.css'
import navStyles from '@/styles/nav.module.css'
import { useMe } from './me'
import { NAME_MUTATION } from '@/fragments/users'
import Avatar from './avatar'
import { userSchema } from '@/lib/validate'
import { numWithUnits, piconerosToMXmr } from '@/lib/format'
import Badges from './badge'
import QuestsModule from './quests-module'
import SubscribeUserDropdownItem from './subscribeUser'
import ActionDropdown from './action-dropdown'
import CodeIcon from '@/svgs/terminal-box-fill.svg'
import MuteDropdownItem from './mute'
import ApiKeyAdminDropdownItem from './api-key-admin'
import { hexToBech32 } from '@/lib/nostr'
import NostrIcon from '@/svgs/nostr.svg'
import { isNostrEnabled } from '@/lib/nostrFeatures'
import GithubIcon from '@/svgs/github-fill.svg'
import TwitterIcon from '@/svgs/twitter-fill.svg'
import { UNKNOWN_LINK_REL } from '@/lib/constants'
import ItemPopover from './item-popover'

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL || `https://${process.env.NEXT_PUBLIC_MEDIA_DOMAIN}`

export default function UserHeader ({ user }) {
  const router = useRouter()

  const pathParts = router.asPath.split('/')
  const activeKey = pathParts[2] === 'territories' ? 'territories' : pathParts.length === 2 ? 'bio' : 'items'
  const showTerritoriesTab = activeKey === 'territories' || user.nterritories > 0

  return (
    <>
      <HeaderHeader user={user} />
      <Nav
        className={navStyles.nav}
        activeKey={activeKey}
      >
        <Nav.Item>
          <Nav.Link as={Link} href={'/' + user.name} eventKey='bio'>bio</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link as={Link} href={'/' + user.name + '/all'} eventKey='items'>
            {numWithUnits(user.nitems, {
              abbreviate: false,
              unitSingular: 'item',
              unitPlural: 'items'
            })}
          </Nav.Link>
        </Nav.Item>
        {showTerritoriesTab && (
          <Nav.Item>
            <Nav.Link as={Link} href={'/' + user.name + '/territories'} eventKey='territories'>
              {numWithUnits(user.nterritories, {
                abbreviate: false,
                unitSingular: 'turf',
                unitPlural: 'turfs'
              })}
            </Nav.Link>
          </Nav.Item>
        )}
      </Nav>
    </>
  )
}

function HeaderPhoto ({ user, isMe }) {
  const [setPhoto] = useMutation(
    gql`
      mutation setPhoto($photoId: ID!) {
        setPhoto(photoId: $photoId)
      }`, {
      update (cache, { data: { setPhoto } }) {
        cache.modify({
          id: `User:${user.id}`,
          fields: {
            photoId () {
              return setPhoto
            }
          }
        })
      }
    }
  )
  const src = user.photoId ? `${MEDIA_URL}/${user.photoId}` : '/xmrgirl.jpg'

  return (
    <div className='position-relative align-self-start' style={{ width: 'fit-content' }}>
      <Image
        src={src} width='135' height='135'
        className={styles.userimg}
      />
      {isMe &&
        <Avatar onSuccess={async photoId => {
          const { error } = await setPhoto({ variables: { photoId } })
          if (error) {
            console.log(error)
          }
        }}
        />}
    </div>
  )
}

function NymEdit ({ user, setEditting }) {
  const router = useRouter()
  const [setName] = useMutation(NAME_MUTATION, {
    update (cache, { data: { setName } }) {
      cache.modify({
        id: `User:${user.id}`,
        fields: {
          name () {
            return setName
          }
        }
      })
    }
  })
  const client = useApolloClient()
  const schema = userSchema({ client })

  return (
    <Form
      schema={schema}
      initial={{
        name: user.name
      }}
      validateImmediately
      validateOnChange={false}
      onSubmit={async ({ name }) => {
        if (name === user.name) {
          setEditting(false)
          return
        }
        const { error } = await setName({ variables: { name } })
        if (error) throw error

        setEditting(false)
        // navigate to new name
        const { nodata, ...query } = router.query
        router.replace({
          pathname: router.pathname,
          query: { ...query, name }
        }, undefined, { shallow: true })
      }}
    >
      <div className='d-flex align-items-center mb-2'>
        <Input
          prepend=<InputGroup.Text>@</InputGroup.Text>
          name='name'
          autoFocus
          groupClassName={styles.usernameForm}
          showValid
          debounce={500}
        />
        <SubmitButton variant='link' onClick={() => setEditting(true)}>save</SubmitButton>
      </div>
    </Form>
  )
}

function NymView ({ user, isMe, setEditting }) {
  const { me } = useMe()
  return (
    <div className='d-flex align-items-center mb-2'>
      <div className={styles.username}>@{user.name}<Badges className='ms-2' user={user} badgeClassName='fill-grey' /></div>
      {isMe &&
        <Button className='py-0' style={{ lineHeight: '1.25' }} variant='link' onClick={() => setEditting(true)}>edit nym</Button>}
      {!isMe && me && <NymActionDropdown user={user} />}
    </div>
  )
}

export function NymActionDropdown ({ user, className = 'ms-2' }) {
  return (
    <div className={className}>
      <ActionDropdown>
        <SubscribeUserDropdownItem user={user} target='posts' />
        <SubscribeUserDropdownItem user={user} target='comments' />
        <MuteDropdownItem user={user} />
        {typeof user.apiKeyEnabled === 'boolean' && <ApiKeyAdminDropdownItem user={user} />}
      </ActionDropdown>
    </div>
  )
}

function HeaderNym ({ user, isMe }) {
  const router = useRouter()
  const [editting, setEditting] = useState(false)

  // if route changes, reset editting state
  useEffect(() => {
    setEditting(false)
  }, [router.asPath])

  return editting
    ? <NymEdit user={user} setEditting={setEditting} />
    : <NymView user={user} isMe={isMe} setEditting={setEditting} />
}

function SocialLink ({ name, id }) {
  const className = `${styles.social} text-reset`
  if (name === 'Nostr') {
    const npub = hexToBech32(id)
    return (
      // eslint-disable-next-line
      <Link className={className} target='_blank' href={`https://njump.me/${npub}`} rel={UNKNOWN_LINK_REL}>
        <NostrIcon width={20} height={20} className='me-1' />
        {npub.slice(0, 10)}...{npub.slice(-10)}
      </Link>
    )
  } else if (name === 'Github') {
    return (
      // eslint-disable-next-line
      <Link className={className} target='_blank' href={`https://github.com/${id}`} rel={UNKNOWN_LINK_REL}>
        <GithubIcon width={20} height={20} className='me-1' />
        {id}
      </Link>
    )
  } else if (name === 'Twitter') {
    return (
      // eslint-disable-next-line
      <Link className={className} target='_blank' href={`https://twitter.com/${id}`} rel={UNKNOWN_LINK_REL}>
        <TwitterIcon width={20} height={20} className='me-1' />@{id}
      </Link>
    )
  }
}

function HeaderHeader ({ user }) {
  const { me } = useMe()

  const isMe = me?.name === user.name
  const Satistics = () => (
    user.optional.stacked !== null
      ? (
        <div className={`mb-2 ms-0 ms-sm-1 ${styles.username} text-success`}>
          {piconerosToMXmr(BigInt(user.optional.stacked))} stashed
        </div>
        )
      : user.optional.stashAmountHidden
        ? (
          <div className={`mb-2 ms-0 ms-sm-1 ${styles.username} text-success`}>
            ??? mXMR stashed
          </div>
          )
        : null
  )

  return (
    <div className='d-flex mt-2 flex-wrap flex-column flex-sm-row'>
      <HeaderPhoto user={user} isMe={isMe} />
      <div className='ms-0 ms-sm-3 mt-3 mt-sm-0 justify-content-center align-self-sm-center'>
        <HeaderNym user={user} isMe={isMe} />
        <Satistics user={user} />
        <div className='d-flex flex-column mt-1 ms-0'>
          <small className='text-muted d-flex-inline'>stashing since: {user.since
            ? (
              <ItemPopover id={user.since}>
                <Link href={`/items/${user.since}`} className='ms-1'>#{user.since}</Link>
              </ItemPopover>
              )
            : <span>never</span>}
          </small>
          {user.optional.maxStreak !== null &&
            <small className='text-muted d-flex-inline'>longest streak: {user.optional.maxStreak}</small>}
          {user.optional.isContributor &&
            <small className='text-muted d-flex align-items-center'>
              <CodeIcon className='me-1' height={16} width={16} /> verified stasher.news contributor
            </small>}
          {isNostrEnabled(me?.privates?.authMethods) && user.optional.nostrAuthPubkey &&
            <small className='text-muted d-flex-inline'>
              <SocialLink name='Nostr' id={user.optional.nostrAuthPubkey} />
            </small>}
          {user.optional.githubId &&
            <small className='text-muted d-flex-inline'>
              <SocialLink name='Github' id={user.optional.githubId} />
            </small>}
          {user.optional.twitterId &&
            <small className='text-muted d-flex-inline'>
              <SocialLink name='Twitter' id={user.optional.twitterId} />
            </small>}
        </div>
      </div>
      {isMe && <div className='qm-wrap'><QuestsModule /></div>}
    </div>
  )
}
