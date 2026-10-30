import { HAS_NOTIFICATIONS, HAS_NOTIFICATIONS_AFTER_VIEW } from '@/fragments/notifications'
import { NORMAL_POLL_INTERVAL_MS, SSR } from '@/lib/constants'
import { useApolloClient, useQuery } from '@apollo/client/react'
import React, { useContext, useEffect, useRef } from 'react'
import { clearNotifications } from '@/components/serviceworker'
import { useMe } from '@/components/me'

export const HasNewNotesContext = React.createContext(false)

export function HasNewNotesProvider ({ me, children }) {
  const { data } = useQuery(HAS_NOTIFICATIONS,
    SSR
      ? {}
      : {
          pollInterval: NORMAL_POLL_INTERVAL_MS,
          nextFetchPolicy: 'cache-and-network'
        })

  useEffect(() => {
    if (data && !data.hasNewNotes) {
      clearNotifications()
    }
  }, [data?.hasNewNotes])

  return (
    <HasNewNotesContext.Provider value={!!data?.hasNewNotes}>
      {children}
    </HasNewNotesContext.Provider>
  )
}

export function useHasNewNotes () {
  return useContext(HasNewNotesContext)
}

// Opening an item directly (a push or chat notification, a bookmark) skips
// /notifications, so the bell stays lit for something already on screen.
// While the bell is lit, ask once per item whether anything outside the
// viewed item is still new; if not, the server has cleared it, so clear it here.
export function useClearNotesOnView (itemId) {
  const hasNewNotes = useHasNewNotes()
  const { me } = useMe()
  const client = useApolloClient()
  const checkedFor = useRef(null)

  useEffect(() => {
    if (!me || !itemId || !hasNewNotes || checkedFor.current === itemId) return
    checkedFor.current = itemId
    client.query({
      query: HAS_NOTIFICATIONS_AFTER_VIEW,
      variables: { viewedItemId: itemId },
      fetchPolicy: 'network-only'
    }).then(({ data }) => {
      if (data && !data.hasNewNotes) {
        client.writeQuery({ query: HAS_NOTIFICATIONS, data: { hasNewNotes: false } })
      }
    }).catch(console.error)
  }, [me?.id, itemId, hasNewNotes, client])
}
