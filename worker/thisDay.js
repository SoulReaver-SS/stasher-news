import { datePivot } from '@/lib/time'
import gql from 'graphql-tag'
import { numWithUnits, piconerosToMXmr } from '@/lib/format'
import { META_SUB, USER_ID } from '@/lib/constants'
import { autoPost } from './weeklyPosts'

export async function thisDay ({ models, apollo, boss }) {
  const days = []
  let yearsAgo = 1
  while (datePivot(new Date(), { years: -yearsAgo }) > new Date('2021-06-10')) {
    const [{ from, to }] = await models.$queryRaw`
    SELECT (date_trunc('day',  (now() AT TIME ZONE 'America/Chicago')) AT TIME ZONE 'America/Chicago') - ${`${yearsAgo} year`}::interval as from,
           (date_trunc('day',  (now() AT TIME ZONE 'America/Chicago')) AT TIME ZONE 'America/Chicago') - ${`${yearsAgo} year`}::interval + interval '1 day - 1 second' as to`

    const { data } = await apollo.query({
      query: THIS_DAY,
      variables: { from: new Date(from).getTime().toString(), to: new Date(to).getTime().toString() }
    })

    days.push({
      data,
      day: new Date(from).toLocaleString('default', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' })
    })

    yearsAgo++
  }

  const date = new Date().toLocaleString('default', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' })

  const text = `${topPosts(days)}
${topStackers(days)}
${topComments(days)}
${topSubs(days)}`

  await autoPost({
    data: {
      text,
      title: `This Day on SN: ${date}`,
      subName: META_SUB,
      userId: USER_ID.sn
    },
    models,
    apollo,
    boss
  })
}

function topPosts (days) {
  let text = '#### Top Posts'
  for (const { day, data } of days) {
    const post = data.posts.items?.[0]
    if (post) {
      text += `
- [${post.title}](${process.env.NEXT_PUBLIC_URL}/items/${post.id})
    - ${piconerosToMXmr(BigInt(post.piconeros ?? 0))} \\ ${numWithUnits(post.ncomments, { unitSingular: 'comment', unitPlural: 'comments' })} \\ @${post.user.name} \\ ~${post.subName} \\ \`${day}\``
    } else {
      text += `
- no top post for \`${day}\``
    }
  }
  return text
}

function topStackers (days) {
  let text = '#### Top Stashers'
  for (const { day, data } of days) {
    const user = data.users.users?.[0]
    if (user) {
      text += `
- @${user.name}
    - ${piconerosToMXmr(BigInt(user.optional?.stacked ?? 0))} stashed \\ ${piconerosToMXmr(BigInt(user.optional?.spent ?? 0))} spent \\ ${numWithUnits(user.nitems, { unitSingular: 'item', unitPlural: 'items' })} \\ \`${day}\``
    } else {
      text += `
- stasher is in hiding for \`${day}\``
    }
  }
  return text
}

export function topComments (days) {
  let text = '#### Top Comments'
  for (const { day, data } of days) {
    const comment = data.comments.items?.[0]
    if (comment) {
      // a Monerowall-covered discussion's top comment resolves with null text
      // for this anon worker (fail-closed gate) — keep the link, drop the quote
      const quote = comment.text ? comment.text.trim().split('\n')[0] : '(walled discussion)'
      text += `
- ${process.env.NEXT_PUBLIC_URL}/items/${comment.root.id}?commentId=${comment.id} on [${comment.root.title}](${process.env.NEXT_PUBLIC_URL}/items/${comment.root.id})
    - ${piconerosToMXmr(BigInt(comment.piconeros ?? 0))} \\ ${numWithUnits(comment.ncomments, { unitSingular: 'reply', unitPlural: 'replies' })} \\ @${comment.user.name} \\ \`${day}\`
        > ${quote} [...]`
    } else {
      text += `
- no top comment for \`${day}\``
    }
  }
  return text
}

function topSubs (days) {
  let text = '#### Top Turfs'
  for (const { day, data } of days) {
    const sub = data.territories.subs?.[0]
    if (sub) {
      text += `
- ~${sub.name}
    - ${piconerosToMXmr(BigInt(sub.optional?.stacked ?? 0))} stashed \\ ${piconerosToMXmr(BigInt(sub.optional?.spent ?? 0))} spent \\ ${numWithUnits(sub.nitems, { unitSingular: 'item', unitPlural: 'items' })} \\ \`${day}\``
    } else {
      text += `
- no top territory for \`${day}\``
    }
  }
  return text
}

const THIS_DAY = gql`
  query thisDay($to: String, $from: String) {
    posts: items (sort: "top", when: "custom", from: $from, to: $to, limit: 1) {
      items {
        id
        title
        text
        url
        ncomments
        piconeros
        subName
        user {
          name
        }
      }
    }
    comments: items (sort: "top", type: "comments", when: "custom", from: $from, to: $to, limit: 1) {
      items {
        id
        parentId
        text
        ncomments
        piconeros
        user {
          name
        }
        root {
          title
          id
          subName
          user {
            name
          }
        }
      }
    }
    users: topUsers(when: "custom", from: $from, to: $to, limit: 1) {
      users {
        name
        nitems(when: "custom", from: $from, to: $to)
        optional {
          stacked(when: "custom", from: $from, to: $to)
          spent(when: "custom", from: $from, to: $to)
        }
      }
    }
    territories: topSubs(when: "custom", from: $from, to: $to, limit: 1) {
      subs {
        name
        createdAt
        desc
        user {
          name
          id
          optional {
            streak
          }
        }
        nitems(when: "custom", from: $from, to: $to)

        optional {
          stacked(when: "custom", from: $from, to: $to)
          spent(when: "custom", from: $from, to: $to)
        }
      }
    }
  }
`
