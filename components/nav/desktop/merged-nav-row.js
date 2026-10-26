import { Nav } from 'react-bootstrap'
import { Back, Brand, NavPrice, NavSelect, PostItem, RightCorner, SearchItem, Sorts, hasNavSelect } from '../common'
import { CommentsNavigator, useCommentsNavigatorContext } from '@/components/use-comments-navigator'
import { useBranding } from '../../territory-branding'
import styles from '../../header.module.css'

// Shared single-row desktop nav content, used by both the merged top header
// (HeaderMerged) and the scroll sticky bar (StickyBar) so the two are
// pixel-identical: same elements (back, brand, turf selector, sorts, search,
// centered price, comment navigator, post button, right
// corner) and the same navMergedRow classes. The second-bar elements keep
// their hasNavSelect / branding gating so non-turf pages look exactly as
// before.
export default function MergedNavRow (props) {
  const { prefix, sub, topNavKey, dropNavKey } = props
  const branding = useBranding()
  const { navigator, commentCount } = useCommentsNavigatorContext()
  const showSubNav = hasNavSelect(props)

  return (
    <Nav
      className={`${styles.navbarNav} navMergedRow`}
      activeKey={topNavKey}
    >
      <Back />
      <Brand className='me-1' />
      {showSubNav && !branding && <NavSelect sub={sub} size='medium' className='me-1' />}
      {showSubNav && (
        <div className='d-flex'>
          <Sorts {...props} className='ms-1' />
        </div>
      )}
      <SearchItem prefix={prefix} className='me-0 ms-2 d-none d-md-flex' />
      <div className='navCenterCluster'>
        <NavPrice className='d-none d-md-flex' />
      </div>
      <div className='ms-auto d-flex align-items-center gap-2'>
        <CommentsNavigator navigator={navigator} commentCount={commentCount} />
        {showSubNav && <PostItem className='d-none d-md-flex' prefix={prefix} />}
        <RightCorner dropNavKey={dropNavKey} className='d-none d-md-flex' />
      </div>
    </Nav>
  )
}
