const { ApolloClient, InMemoryCache, HttpLink, gql } = require('@apollo/client')
const { datePivot } = require('../lib/time.js')
const { piconerosToMXmr } = require('../lib/format.js')
const { buildGateCookieHeader } = require('../lib/invite-gate.js')

const ITEMS = gql`
  query items ($sort: String, $when: String, $sub: String, $by: String, $from: String, $to: String, $limit: Limit) {
    items (sort: $sort, when: $when, sub: $sub, by: $by, from: $from, to: $to, limit: $limit) {
      cursor
      items {
        id
        title
        url
        ncomments
        piconeros
        cost
        company
        status
        location
        remote
        boost
        subName
        user {
          id
          name
        }
      }
    }
  }
`

const TOP_COWBOYS = gql`
query TopCowboys($cursor: String) {
  topCowboys(cursor: $cursor) {
    users {
      name
      optional {
        streak
      }
    }
    cursor
  }
}`

const TOP_USERS = gql`
  query TopUsers($cursor: String, $when: String, $from: String, $to: String, $by: String, ) {
    topUsers(cursor: $cursor, when: $when, from: $from, to: $to, by: $by) {
      users {
        name
        optional {
          stacked(when: $when, from: $from, to: $to)
          spent(when: $when, from: $from, to: $to)
        }
      }
      cursor
    }
  }
`

const gateCookieHeader = buildGateCookieHeader()

const client = new ApolloClient({
  link: new HttpLink({
    uri: 'https://stasher.news/api/graphql',
    headers: gateCookieHeader ? { Cookie: gateCookieHeader } : undefined
  }),
  cache: new InMemoryCache()
})

const SEARCH = gql`
query Search($q: String, $sort: String, $what: String, $when: String, $from: String, $to: String) {
  search(q: $q, sort: $sort, what: $what, when: $when, from: $from, to: $to) {
    items {
      id
      title
      bountyPaidTo
    }
  }
}`

const to = String(new Date(new Date().setHours(0, 0, 0, 0)).getTime())
const from = String(datePivot(new Date(Number(to)), { days: -8 }).getTime())

// we don't have bounties in the newsletter currently
// eslint-disable-next-line no-unused-vars
async function bountyWinner (q) {
  const WINNER = gql`
    query Item($id: ID!) {
      item(id: $id) {
        text
        piconeros
        imgproxyUrls
        user {
          name
        }
      }
    }`

  const bounty = await client.query({
    query: SEARCH,
    variables: { q: `${q} @sn`, sort: 'new', what: 'posts', when: 'custom', from, to }
  })

  const items = bounty.data.search.items.filter(i => i.bountyPaidTo?.length > 0)
  if (items.length === 0) return

  try {
    const item = await client.query({
      query: WINNER,
      variables: { id: items[0].bountyPaidTo[0] }
    })

    const winner = { ...item.data.item, image: Object.values(item.data.item.imgproxyUrls)[0]?.['640w'] }

    return { bounty: items[0].id, winner }
  } catch (e) {

  }
}

async function topComment (q) {
  const TOP_COMMENT = gql`
    query Item($id: ID!) {
      item(id: $id) {
          comments(sort: "top") {
          comments {
            text
            piconeros
            user {
              name
            }
            imgproxyUrls
          }
        }
      }
    }`

  const items = await client.query({
    query: SEARCH,
    variables: { q: `${q} @sn`, sort: 'new', what: 'posts', when: 'custom', from, to }
  })

  const post = items?.data.search.items?.length > 0 ? items.data.search.items[0] : null

  if (!post) return

  try {
    const item = await client.query({
      query: TOP_COMMENT,
      variables: { id: post.id }
    })

    const topComment = item.data.item.comments.comments[0]

    const winner = { ...topComment, image: Object.values(topComment.imgproxyUrls)[0]?.['640w'] }

    return { item: post.id, winner }
  } catch (e) {
  }
}

async function getTopUsers ({ by, cowboys = false, includeHidden = false, count = 5, when = 'custom', from, to } = {}) {
  const accum = []
  let cursor = ''
  try {
    while (accum.length < count) {
      let variables = {
        cursor
      }
      if (!cowboys) {
        variables = {
          ...variables,
          by,
          when,
          from,
          to
        }
      }
      const result = await client.query({
        query: cowboys ? TOP_COWBOYS : TOP_USERS,
        variables
      })
      cursor = result.data[cowboys ? 'topCowboys' : 'topUsers'].cursor
      accum.push(...result.data[cowboys ? 'topCowboys' : 'topUsers'].users.filter(user => includeHidden ? true : !!user).filter(user => user.name !== 'stasher'))
    }
  } catch (e) {

  }
  return accum.slice(0, count)
}

async function main () {
  const top = await client.query({
    query: ITEMS,
    variables: { sort: 'top', when: 'custom', from, to, limit: 30 }
  })

  const meta = await client.query({
    query: ITEMS,
    variables: { sort: 'top', when: 'custom', from, to, sub: 'stasher' }
  })

  const ama = await client.query({
    query: ITEMS,
    variables: { sort: 'top', when: 'custom', from, to, sub: 'ama' }
  })

  const topMeme = await topComment('meme monday ~memes')

  const topCowboys = await getTopUsers({ cowboys: true, when: 'custom', from, to })
  const topStackers = await getTopUsers({ by: 'stacked', when: 'custom', from, to })
  const topSpenders = await getTopUsers({ by: 'spent', when: 'custom', from, to })

  process.stdout.write(
`Happy Saturday Stashers,

Have a great weekend!

##### Top Posts
${top.data.items.items.map((item, i) =>
  `${i + 1}. [${item.title}](https://stasher.news/items/${item.id})
    - ${piconerosToMXmr(BigInt(item.piconeros) + BigInt(item.boost) + BigInt(item.cost) * 1000n)} \\ ${item.ncomments} comments \\ [@${item.user.name}](https://stasher.news/${item.user.name})\n`).join('')}

##### Top AMAs
${ama.data.items.items.slice(0, 10).map((item, i) =>
  `${i + 1}. [${item.title}](https://stasher.news/items/${item.id})
    - ${piconerosToMXmr(BigInt(item.piconeros) + BigInt(item.boost) + BigInt(item.cost) * 1000n)} \\ ${item.ncomments} comments \\ [@${item.user.name}](https://stasher.news/${item.user.name})\n`).join('')}

[**all of this week's AMAs**](https://stasher.news/~ama/top/posts/week)

##### Don't miss
${top.data.items.items.map((item, i) =>
  `- [${item.title}](https://stasher.news/items/${item.id})\n`).join('')}

[**all of this week's top posts**](https://stasher.news/top/posts/week)

-------

##### Top stasher
${meta.data.items.items.slice(0, 10).map((item, i) =>
  `- [${item.title}](https://stasher.news/items/${item.id})\n`).join('')}

[**all of this week's stasher**](https://stasher.news/~stasher/top/posts/week)

-------

##### Top Monday meme
![](${new URL(topMeme?.winner.image, 'https://media.stasher.news').href})

[**all monday memes**](https://stasher.news/items/${topMeme?.item})

------

##### Top Stashers
${topStackers.map((user, i) =>
    `${i + 1}. [@${user.name}](https://stasher.news/${user.name}): ${piconerosToMXmr(BigInt(user.optional.stacked))} stashed`
).join('\n')}

------

##### Top Spenders
${topSpenders.map((user, i) =>
    `${i + 1}. [@${user.name}](https://stasher.news/${user.name}): ${piconerosToMXmr(BigInt(user.optional.spent))} spent`
).join('\n')}

------

##### Top Cowboys
${topCowboys.map((user, i) =>
  `${i + 1}. [@${user.name}](https://stasher.news/${user.name}): ${user.optional.streak} days`
).join('\n')}

------

Fellow fugitives,
Keyan
A guy who works on Stasher News

[Watch](https://www.youtube.com/@stashernews/live) or [Listen to](https://www.fountain.fm/show/Mg1AWuvkeZSFhsJZ3BW2) or [Read in print](https://www.plebpoet.com/zines.html) SN's top stories every week.

Get this newsletter sent to your email inbox by linking an email at https://stasher.news/settings and keeping the newsletter box checked.`)
}

main()
