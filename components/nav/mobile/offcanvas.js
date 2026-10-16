import { useMemo, useState } from 'react'
import { Dropdown, Image, Nav, Navbar, Offcanvas } from 'react-bootstrap'
import { PUBLIC_MEDIA_URL } from '@/lib/constants'
import Link from 'next/link'
import { Indicator, LoginButtons, LogoutDropdownItem, NavWalletSummary } from '../common'
import AnonIcon from '@/svgs/spy-fill.svg'
import styles from './footer.module.css'
import canvasStyles from './offcanvas.module.css'
import classNames from 'classnames'
import { useWalletIndicator } from '@/wallets/client/hooks'

function MeImage ({ me }) {
  const src = useMemo(() => me?.photoId ? `${PUBLIC_MEDIA_URL}/${me.photoId}` : '/xmrgirl.jpg', [me?.photoId])
  if (!me) {
    return <AnonIcon aria-hidden='true' focusable='false' width='22' height='22' className='text-muted' />
  }
  return (
    <Image
      src={src} width='28' height='28' alt=''
      className={canvasStyles.meimg}
    />
  )
}

export default function OffCanvas ({ me, dropNavKey }) {
  const [show, setShow] = useState(false)

  const handleClose = () => setShow(false)
  const handleShow = () => setShow(true)

  const profileIndicator = me && !me.bioId
  const walletIndicator = useWalletIndicator()
  const indicator = profileIndicator || walletIndicator

  return (
    <>
      <Indicator show={indicator}>
        <span
          role='button' tabIndex={0} className='pointer'
          aria-label='account menu' aria-haspopup='dialog' aria-expanded={show}
          onClick={handleShow}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleShow()
            }
          }}
        >
          <MeImage me={me} />
        </span>
      </Indicator>
      <Offcanvas className={canvasStyles.offcanvas} show={show} onHide={handleClose} placement='end'>
        <Offcanvas.Header closeButton>
          <Offcanvas.Title><NavWalletSummary /></Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body className='pb-0'>
          <div style={{
            '--bs-dropdown-item-padding-y': '.5rem',
            '--bs-dropdown-item-padding-x': 0,
            '--bs-dropdown-divider-bg': '#ced4da',
            '--bs-dropdown-divider-margin-y': '0.5rem',
            height: '100%',
            display: 'flex',
            flexDirection: 'column'
          }}
          >
            {me
              ? (
                <>
                  <Dropdown.Item as={Link} href={'/' + me.name} active={me.name === dropNavKey}>
                    <Indicator show={profileIndicator} top='2px' right='-10px'>profile</Indicator>
                  </Dropdown.Item>
                  <Dropdown.Item as={Link} href={'/' + me.name + '/bookmarks'} active={me.name + '/bookmarks' === dropNavKey}>bookmarks</Dropdown.Item>
                  <Dropdown.Item as={Link} href='/settings/wallet' eventKey='wallets'>
                    <Indicator show={walletIndicator} top='2px' right='-10px'>wallets</Indicator>
                  </Dropdown.Item>
                  <Dropdown.Item as={Link} href='/statistics' eventKey='statistics'>Statistics</Dropdown.Item>
                  <Dropdown.Divider />
                  <Dropdown.Item as={Link} href='/referrals/day' eventKey='referrals'>referrals</Dropdown.Item>
                  <Dropdown.Divider />
                  <div className='d-flex align-items-center'>
                    <Dropdown.Item as={Link} href='/settings' eventKey='settings'>settings</Dropdown.Item>
                  </div>
                  <Dropdown.Divider />
                  <LogoutDropdownItem handleClose={handleClose} />
                </>
                )
              : <LoginButtons />}
            {me && (
              <div className={classNames(styles.footerPadding, 'mt-auto')}>
                <Navbar className={classNames('container d-flex flex-row px-0 text-muted')}>
                  <Nav>
                    <Link href={`/${me.name}`} className='d-flex flex-row p-2 mt-auto text-muted'>
                      <MeImage me={me} />
                      <div className='ms-2'>
                        <Indicator show={indicator} top='2px' right='-5px'>@{me.name}</Indicator>
                      </div>
                    </Link>
                  </Nav>
                </Navbar>
              </div>
            )}
          </div>
        </Offcanvas.Body>
      </Offcanvas>
    </>
  )
}
