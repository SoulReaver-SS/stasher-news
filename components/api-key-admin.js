import { useMutation } from '@apollo/client/react'
import { gql } from 'graphql-tag'
import Dropdown from 'react-bootstrap/Dropdown'
import { useToast } from './toast'

const SET_API_KEY_ENABLED = gql`
  mutation setApiKeyEnabled($id: ID!, $enabled: Boolean!) {
    setApiKeyEnabled(id: $id, enabled: $enabled) {
      id
      apiKeyEnabled
    }
  }`

// admin only: the server returns user.apiKeyEnabled as null for everyone
// else, so callers render this only when it is a boolean
export default function ApiKeyAdminDropdownItem ({ user: { id, name, apiKeyEnabled } }) {
  const toaster = useToast()
  const [setApiKeyEnabled] = useMutation(SET_API_KEY_ENABLED)
  const enabled = !apiKeyEnabled

  return (
    <Dropdown.Item
      onClick={async () => {
        try {
          await setApiKeyEnabled({ variables: { id, enabled } })
          toaster.success(`${enabled ? 'enabled' : 'disabled'} API keys for ${name}`)
        } catch (err) {
          console.error(err)
          toaster.danger(err.message ?? `failed to ${enabled ? 'enable' : 'disable'} API keys for ${name}`)
        }
      }}
    >
      {`${enabled ? 'enable' : 'disable'} API keys`}
    </Dropdown.Item>
  )
}
