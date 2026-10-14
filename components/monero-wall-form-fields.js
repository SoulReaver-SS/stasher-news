import { useField, useFormikContext } from 'formik'
import { Col, Form as BootstrapForm, Row } from 'react-bootstrap'
import { Checkbox, Input } from './form'
import { piconerosToXmrDecimal, xmrToPiconeros } from '@/lib/format'

// Form keys: moneroWallEnabled (UI-only toggle), moneroWallPriceXmr /
// moneroWallThresholdXmr (display), moneroWallPricePiconeros /
// moneroWallThresholdPiconeros (submitted; BigInt strings to GraphQL).
// Draft-aware: drafts store wall amounts as piconeros directly (no active
// wall row), items keep their moneroWall shape. An item wins over a draft,
// and a draft without wall amounts yields the plain disabled-wall defaults.
export function moneroWallInitialValues (item, draft) {
  const wall = item?.moneroWall ?? (draft != null && (draft.moneroWallPricePiconeros != null || draft.moneroWallThresholdPiconeros != null)
    ? {
        pricePiconeros: draft.moneroWallPricePiconeros != null ? String(draft.moneroWallPricePiconeros) : null,
        thresholdPiconeros: draft.moneroWallThresholdPiconeros != null ? String(draft.moneroWallThresholdPiconeros) : null
      }
    : undefined)
  const enabled = !!wall
  const coversComments = !!(item?.moneroWall?.coversComments ?? draft?.moneroWallCoversComments)
  return {
    moneroWallEnabled: enabled,
    moneroWallCoversComments: coversComments,
    moneroWallPriceXmr: wall?.pricePiconeros != null ? piconerosToXmrDecimal(BigInt(wall.pricePiconeros)) : '',
    moneroWallThresholdXmr: wall?.thresholdPiconeros != null ? piconerosToXmrDecimal(BigInt(wall.thresholdPiconeros)) : '',
    moneroWallPricePiconeros: wall?.pricePiconeros != null ? String(wall.pricePiconeros) : null,
    moneroWallThresholdPiconeros: wall?.thresholdPiconeros != null ? String(wall.thresholdPiconeros) : null
  }
}

function toPiconeroString (xmr) {
  if (!xmr) return null
  try {
    return String(xmrToPiconeros(xmr))
  } catch {
    return null
  }
}

const NO_WALL_LEG_ERROR = 'a monerowall needs an individual unlock threshold, a global unlock threshold, or both'
const INVALID_XMR_LEG_ERROR = 'enter a valid XMR amount (max 12 decimals)'

function hasValidWallLeg (piconeros) {
  if (piconeros == null) return false
  try {
    return BigInt(piconeros) > 0n
  } catch {
    return false
  }
}

export default function MoneroWallFields ({ item }) {
  const { values, errors, setFieldValue } = useFormikContext()
  const editing = !!item
  const wallActive = editing && !!item.moneroWall

  useField({
    name: 'moneroWallPricePiconeros',
    validate: (pricePiconeros) => {
      if (editing) return undefined
      if (!values.moneroWallEnabled) return undefined
      if (hasValidWallLeg(pricePiconeros) || hasValidWallLeg(values.moneroWallThresholdPiconeros)) return undefined
      return NO_WALL_LEG_ERROR
    }
  })

  // An unparseable display amount (exponent notation, >12 decimals, negative,
  // zero) has a null/invalid piconeros companion, so the raw text would
  // otherwise be dropped silently at submit. Flag each non-empty display leg
  // whose normalized amount is not a valid > 0 XMR value. Create only: the
  // edit path does not force errors on legacy X/T values.
  const validateXmrLeg = (xmr) => {
    if (editing) return undefined
    if (!values.moneroWallEnabled) return undefined
    const value = xmr == null ? '' : String(xmr).trim()
    if (!value) return undefined
    if (hasValidWallLeg(toPiconeroString(value))) return undefined
    return INVALID_XMR_LEG_ERROR
  }
  useField({ name: 'moneroWallPriceXmr', validate: validateXmrLeg })
  useField({ name: 'moneroWallThresholdXmr', validate: validateXmrLeg })

  // Walls are create-time only (2026-09-21 amendment): never render wall
  // controls when editing a post without an active wall — no add-at-edit,
  // no re-add after removal. Removal itself lives in the author view
  // (Task 10, removeMoneroWall).
  if (editing && !wallActive) return null

  const noWallLeg = !editing && values.moneroWallEnabled &&
    !hasValidWallLeg(values.moneroWallPricePiconeros) && !hasValidWallLeg(values.moneroWallThresholdPiconeros)
  // Specific per-leg errors render on their own Input, so suppress the generic
  // no-leg message while one is present (an unparseable amount would otherwise
  // show both).
  const legError = !!(errors.moneroWallPriceXmr || errors.moneroWallThresholdXmr)
  const wallError = [errors.moneroWallPricePiconeros, errors.moneroWallThresholdPiconeros].filter(Boolean).join('; ')

  return (
    <div className='my-2'>
      {editing
        ? <div className='text-muted fw-bold my-1'>monerowall (added at creation{item?.moneroWall?.coversComments ? ' — the discussion is walled too' : ''} — X/T editable until the first payment; removal is permanent)</div>
        : (
          <>
            <Checkbox
              label='monerowall'
              name='moneroWallEnabled'
              handleChange={(checked) => {
                if (checked) return
                setFieldValue('moneroWallPriceXmr', '')
                setFieldValue('moneroWallThresholdXmr', '')
                setFieldValue('moneroWallPricePiconeros', null)
                setFieldValue('moneroWallThresholdPiconeros', null)
                setFieldValue('moneroWallCoversComments', false)
              }}
            />
            <BootstrapForm.Text className='text-muted d-block mt-1 ms-4'>
              add a Monerowall (paywall) to your content. it&apos;s meant for long-form work like articles, guides, literary writing, and other useful or valuable information. readers pay a fee to unlock it.
            </BootstrapForm.Text>
          </>
          )}
      {(editing || values.moneroWallEnabled) && (
        <>
          <Row className='me-0'>
            <Col>
              <Input
                label='individual unlock threshold (XMR)'
                name='moneroWallPriceXmr'
                type='number'
                step='0.0001'
                min='0.0001'
                placeholder='0.001'
                hint='readers pay this to read it themselves'
                onChange={(formik, e) => setFieldValue('moneroWallPricePiconeros', toPiconeroString(e.target.value))}
              />
            </Col>
            <Col>
              <Input
                label='global unlock threshold (XMR)'
                name='moneroWallThresholdXmr'
                type='number'
                step='0.0001'
                min='0.0001'
                placeholder='0.01'
                hint='total tips that unlock it for everyone'
                onChange={(formik, e) => setFieldValue('moneroWallThresholdPiconeros', toPiconeroString(e.target.value))}
              />
            </Col>
          </Row>
          {/* create-time only (like the wall itself): the discussion wall can
              never be added to an existing post, and opening it later goes
              through the author panel's one-way "open the discussion" action */}
          {!editing && values.moneroWallEnabled && (
            <>
              <Checkbox
                label='Wall the comment section too'
                name='moneroWallCoversComments'
                groupClassName='ms-4'
              />
              <BootstrapForm.Text className='text-muted d-block mt-1 ms-4'>
                keep replies and discussion visible only to stashers who unlocked this post.
              </BootstrapForm.Text>
            </>
          )}
          {(wallError || noWallLeg) && !legError && (
            <BootstrapForm.Text className='text-danger small d-block mt-1'>
              {wallError || NO_WALL_LEG_ERROR}
            </BootstrapForm.Text>
          )}
        </>
      )}
    </div>
  )
}
