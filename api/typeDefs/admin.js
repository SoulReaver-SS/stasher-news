import { gql } from 'graphql-tag'

export default gql`
  extend type Query {
    snl: Boolean!
  }

  extend type Mutation {
    onAirToggle: Boolean!

    """
    admin only: allow or disallow a user to generate an API key.
    disabling also revokes the user's current key.
    """
    setApiKeyEnabled(id: ID!, enabled: Boolean!): User!
  }
`
