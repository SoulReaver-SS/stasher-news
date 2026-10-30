import { SN_ADMIN_IDS } from '@/lib/constants'
import { GqlAuthenticationError, GqlAuthorizationError, GqlInputError } from '@/lib/error'

export function isAdmin (me) {
  return !!me && SN_ADMIN_IDS.includes(Number(me.id))
}

export default {
  Query: {
    snl: async (parent, _, { models }) => {
      const snl = await models.snl.findFirst()
      return !!snl?.live
    }
  },
  Mutation: {
    onAirToggle: async (parent, _, { models, me }) => {
      if (!me || !SN_ADMIN_IDS.includes(me.id)) {
        throw new Error('not an admin')
      }
      const { id, live } = await models.snl.findFirst()
      await models.snl.update({ where: { id }, data: { live: !live } })
      return !live
    },
    setApiKeyEnabled: async (parent, { id, enabled }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      if (!isAdmin(me)) {
        throw new GqlAuthorizationError('not an admin')
      }

      const userId = Number(id)
      const user = await models.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!user) {
        throw new GqlInputError('user not found')
      }

      // disabling also drops the stored key hash, so turning it back on never
      // brings an old key back to life; the user has to generate a fresh one
      return await models.user.update({
        where: { id: userId },
        data: enabled
          ? { apiKeyEnabled: true }
          : { apiKeyEnabled: false, apiKeyHash: null }
      })
    }
  }
}
