import gql from 'graphql-tag'

export const DRAFT_FIELDS = gql`
  fragment DRAFT_FIELDS on Draft {
    id
    type
    title
    text
    url
    subName
    extra
    moneroWallPricePiconeros
    moneroWallThresholdPiconeros
    moneroWallCoversComments
    pinnedMediaBytes
    pinnedMediaCount
    updatedAt
  }
`

export const MY_DRAFTS = gql`
  ${DRAFT_FIELDS}
  query MY_DRAFTS {
    myDrafts {
      ...DRAFT_FIELDS
    }
  }
`

export const MY_DRAFT = gql`
  ${DRAFT_FIELDS}
  query MY_DRAFT($id: ID!) {
    draft(id: $id) {
      ...DRAFT_FIELDS
    }
  }
`

export const UPSERT_DRAFT = gql`
  ${DRAFT_FIELDS}
  mutation UPSERT_DRAFT($input: DraftInput!) {
    upsertDraft(input: $input) {
      ...DRAFT_FIELDS
    }
  }
`

export const DELETE_DRAFT = gql`
  mutation DELETE_DRAFT($id: ID!) {
    deleteDraft(id: $id)
  }
`
