<p align="center">
<a href="https://stasher.news">
<img height="50" alt="sn banner" src="https://raw.githubusercontent.com/stashernews/stasher-news/master/public/stasher-news-wordmark.png">
</a>
</p>


- Stasher News is a fork of Stacker News for Monero.
- Non-custodial Monero payments: tips, posting fees, rewards
- Next.js, postgres, graphql, and monerod + monero-lws

<br>

# Getting started

Launch a fully featured SN development environment in a single command.

```sh
$ ./sndev start
```

Go to [localhost:3000](http://localhost:3000).

<br>

## Installation

- Clone the repo
   - ssh: `git clone git@github.com:stashernews/stasher-news.git`
   - https: `git clone https://github.com/stashernews/stasher-news.git`
- Install [docker](https://docs.docker.com/compose/install/)
    - If you're running MacOS or Windows, I ***highly recommend***  using [OrbStack](https://orbstack.dev/) instead of Docker Desktop
- Please make sure that at least 10 GB of free space is available, otherwise you may encounter issues while setting up the development environment.

<br>

## Usage

Start the development environment

```sh
$ ./sndev start
```

View all available commands

```sh
$ ./sndev help

                            888
                            888
                            888
      .d8888b  88888b.  .d88888  .d88b.  888  888
     88K      888 '88b d88' 888 d8P  Y8b 888  888
     'Y8888b. 888  888 888  888 88888888 Y88  88P
          X88 888  888 Y88b 888 Y8b.      Y8bd8P
      88888P' 888  888  'Y88888  'Y8888    Y88P

manages a docker based stasher news development environment

USAGE
  $ sndev [COMMAND]
  $ sndev help [COMMAND]

COMMANDS
  help                    show help

  env:
    start                 start env
    stop                  stop env
    restart               restart env
    status                status of env
    logs                  logs from env
    delete                delete env

  sn:
    login                 login as a nym

  codespaces:
    setup_codespaces      setup environment for GitHub Codespaces

  db:
    psql                   open psql on db
    prisma                 run prisma commands

  domains:
    domains                custom domains dev management

  monero:
    monero                 monerod + monero-lws management (network set by MONERO_NETWORK)

  dev:
    pr                     fetch and checkout a pr
    lint                   run linters
    test                   run tests

  other:
    cli                    service cli passthrough
    open                   open service GUI in browser
    onion                  service onion address
    cert                   service tls cert
    compose                docker compose passthrough
```

### Modifying services

#### Running specific services

By default all services except the Monero stack will be run — the `monero` profile is opt-in. If you want to exclude specific services from running, set `COMPOSE_PROFILES` in a `.env.local` file to one or more of `minimal,images,search,monero,email,capture,domains,domains-caddy`. To only run minimal necessary without things like payments in `.env.local`:

```.env
COMPOSE_PROFILES=minimal
```

To run with images and monero services:

```.env
COMPOSE_PROFILES=images,monero
```

#### Merging compose files

By default `sndev start` will merge `docker-compose.yml` with `docker-compose.override.yml`. Specify any overrides you want to merge with `docker-compose.override.yml`.

For example, if you want to replace the db seed with a custom seed file located in `docker/db/another.sql`, you'd create a `docker-compose.override.yml` file with the following:

```yml
services:
  db:
    volumes:
      - ./docker/db/another.sql:/docker-entrypoint-initdb.d/seed.sql
```

You can read more about [docker compose override files](https://docs.docker.com/compose/multiple-compose-files/merge/).

#### Enabling semantic search

Semantic search is now enabled automatically in dev when the `search` profile is active.

- Ensure `search` is in `COMPOSE_PROFILES`:

    ```.env
    COMPOSE_PROFILES=...,search,...
    ```
- Start your environment with `./sndev start`.
- On first boot, OpenSearch downloads and deploys the embedding model, then creates a neural-ready index. This can take a couple minutes.

No manual script run or container restart is required for the default setup.

If you need to manually repair or recreate semantic search resources, restart from a fresh dev volume with `./sndev delete` and then run `./sndev start`.

#### Local DNS via dnsmasq

To enable dnsmasq:

- domains should be enabled in `COMPOSE_PROFILES`:

    ```.env
    COMPOSE_PROFILES=...,domains,...
    ```

To add/remove DNS records you can now use `./sndev domains dns`. More on this [here](#add-or-remove-dns-records-in-local).

The `domains` profile enables dnsmasq and custom-domain worker jobs. The bundled Caddy HTTPS proxy is separate in `domains-caddy`, so you can keep local domain verification while omitting Caddy if an external TLS-terminating load balancer handles your dev domains. The bundled Caddy proxy can also serve production: point DNS for `stasher.news` at the host, set `CADDYFILE=./docker/caddy/Caddyfile.prod` in the deployment env, and Caddy issues automatic Let's Encrypt certificates (the dev Caddyfile with its internal CA must not be used for real domains).

<br>

# Table of Contents
- [Getting started](#getting-started)
    - [Installation](#installation)
    - [Usage](#usage)
        - [Modifying services](#modifying-services)
            - [Running specific services](#running-specific-services)
            - [Merging compose files](#merging-compose-files)
- [Contributing](#contributing)
- [Development Tips](#development-tips)
    - [Linting](#linting)
    - [Database migrations](#database-migrations)
    - [Connecting to the local database](#connecting-to-the-local-database)
    - [Running cli on local monero nodes](#running-cli-on-local-monero-nodes)
    - [Testing local auth](#testing-local-auth)
        - [Login with Email](#login-with-email)
        - [Login with Github](#login-with-github)
    - [Enabling web push notifications](#enabling-web-push-notifications)
    - [Custom domains](#custom-domains)
- [Internals](#internals)
    - [Stack](#stack)
    - [Services](#services)
    - [Wallet transaction safety](#wallet-transaction-safety)
- [Need help?](#need-help)
- [Responsible Disclosure](#responsible-disclosure)
- [License](#license)

<br>

# Contributing

We want your help. Contributions are welcome in the form of pull requests, issues,
code review, documentation, and bug reports.

There is currently no contribution awards program. We may introduce one in the
future — if we do, this section will be updated.

Open a [discussion](https://github.com/stashernews/stasher-news/discussions) or
[issue](https://github.com/stashernews/stasher-news/issues/new) to get started.

<br>

# Development Tips

<br>

## Linting

We use [JavaScript Standard Style](https://standardjs.com/) to enforce code style and correctness. You should run `sndev lint` before submitting a PR.

If you're using VSCode, you can install the [StandardJS VSCode Extension](https://marketplace.visualstudio.com/items?itemName=standard.vscode-standard) extension to get linting in your editor. We also recommend installing [StandardJS code snippets](https://marketplace.visualstudio.com/items?itemName=capaj.vscode-standardjs-snippets) and [StandardJS react code snippets](https://marketplace.visualstudio.com/items?itemName=TimonVS.ReactSnippetsStandard) for code snippets.

<br>

## Database migrations

We use [prisma](https://www.prisma.io/) for our database migrations. To create a new migration, modify `prisma/schema.prisma` according to [prisma schema reference](https://www.prisma.io/docs/orm/reference/prisma-schema-reference) and apply it with:

`./sndev prisma migrate dev`

If you want to create a migration without applying it, eg to create a trigger or modify the generated sql before applying, use the `--create-only` option:

`./sndev prisma migrate dev --create-only`

Generate the local copy of the prisma ORM client in `node_modules` after changes. This should only be needed to get Intellisense in your editor locally.

`./sndev prisma generate`

<br>

## Connecting to the local database

You can connect to the local database via `./sndev psql`. [psql](https://www.postgresql.org/docs/13/app-psql.html) is an interactive terminal for working with PostgreSQL.

<br>

## Running cli on local monero nodes

The local monero stack consists of a `monerod` daemon and a `monero-lws` light wallet server, on the network set by `MONERO_NETWORK` (stagenet by default). Manage them with:

```sh
$ ./sndev monero status         # monerod + lws health
$ ./sndev monero accounts       # list lws-watched accounts
$ ./sndev monero add_account <address> <viewkey>
$ ./sndev monero faucet <address>   # print faucet/explorer URLs (network-aware)
$ ./sndev monero rescan <address> <height>
```

For a raw shell on either service use `./sndev compose exec monerod bash` or `./sndev compose exec monero-lws bash`.

<br>

## Testing local auth

You can login to test features like posting, replying, tipping, etc with `./sndev login <nym>` which will provide a link to login as an existing nym or a new account for a nonexistent nym. But, it you want to test auth specifically you'll need to configure them in your `.env` file.

### Login with Email

#### MailHog

- The app is already prepared to send emails through [MailHog](https://github.com/mailhog/MailHog) so no extra configuration is needed
- Click "sign up" and enter any email address (remember, it's not going anywhere beyond your workstation)
- Access MailHog's web UI on http://localhost:8025
- Click the link (looks like this):

```
http://localhost:3000/api/auth/callback/email?email=satoshi%40gmail.com&token=110e30a954ce7ca643379d90eb511640733de405f34a31b38eeda8e254d48cd7
```

#### Sendgrid

- Create a Sendgrid account (or other smtp service)

```
LOGIN_EMAIL_SERVER=smtp://apikey:<sendgrid_api_key>@smtp.sendgrid.net:587
LOGIN_EMAIL_FROM=<sendgrid_email_from>
```

- Click "sign up" and enter your email address
- Check your email
- Click the link (looks like this):

```
http://localhost:3000/api/auth/callback/email?email=satoshi%40gmail.com&token=110e30a954ce7ca643379d90eb511640733de405f34a31b38eeda8e254d48cd7
```

### Login with Github

- [Create a new OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) in your Github account
  - Set the callback URL to: `http://localhost:3000/api/auth/callback/github`
- Update your `.env` file

```
GITHUB_ID=<Client ID>
GITHUB_SECRET=<Client secret>
```
- Signup and login as above

<br>

## Enabling web push notifications

To enable Web Push, set the `VAPID_*` env vars in gitignored `.env.local` (never in tracked env files). `VAPID_MAILTO` needs to be an email address using the `mailto:` scheme. For `NEXT_PUBLIC_VAPID_PUBKEY` and `VAPID_PRIVKEY`, you can run `npx web-push generate-vapid-keys`.

`NEXT_PUBLIC_VAPID_PUBKEY` is inlined into the client at build time — after adding or changing it on the VPS you must rebuild (`NODE_ENV=production npm run build`) before `docker compose ... up -d`. Without all three vars the site runs fine but push is disabled: no push UI is shown and the server logs `webPush not configured, skipping notification`.

<br>

## Custom domains

### Add or remove DNS records in local

A worker dedicated to verifying custom domains, checks, among other things, if a domain has the correct DNS records and values. This would normally require a real domain and access to its DNS configuration. Therefore we use dnsmasq to have local DNS, make sure you have [enabled it](#local-dns-via-dnsmasq).

If you access local custom domains through the bundled Caddy proxy, keep `domains-caddy` enabled too. If you use your own TLS-terminating load balancer, it should forward `X-Forwarded-Proto: https` so dev cookies that depend on secure requests are marked `Secure`. Production deployments of the same service set `CADDYFILE=./docker/caddy/Caddyfile.prod` (default is the dev Caddyfile; a missing var is a loud failure — an untrusted certificate — never a silent wrong config).

To add a DNS record the syntax is the following:

`./sndev domains dns add|remove cname|txt <name/domain> <value>`

For TXT records, you can also use `""` quoted strings on `value`.

To list all DNS records present in the dnsmasq config: `./sndev domains dns list`

#### Access a local custom domain added via dnsmasq
sndev will use the dnsmasq DNS server by default, but chances are that you might want to access the domain via your browser.

For every edit on dnsmasq, it will give you the option to either edit the `/etc/hosts` file or use the dnsmasq DNS server which can be reached on `127.0.0.1:53530`. You can avoid getting asked to edit the `/etc/hosts` file by adding the `--no-hosts` parameter.

# Internals

<br>

## Stack

The site is written in javascript (not typescript 😱) using [Next.js](https://nextjs.org/), a [React](https://react.dev/) framework. The backend API is provided via [GraphQL](https://graphql.org/). The database is [PostgreSQL](https://www.postgresql.org/) modeled with [Prisma](https://www.prisma.io/). The [job queue](https://github.com/timgit/pg-boss) is also maintained in PostgreSQL. We use [monerod](https://github.com/monero-project/monero) and [monero-lws](https://github.com/vtnerd/monero-lws) for our non-custodial monero payment layer. A customized [Bootstrap](https://react-bootstrap.netlify.app/) theme is used for styling.

<br>

## Services

Currently, SN runs and maintains two significant services and one microservice:

1. the nextjs web app, found in `./`
2. the worker service, found in `./worker`, which runs periodic jobs and jobs sent to it by the web app
3. a screenshot microservice, found in `./capture`, which takes screenshots of SN for social previews

In addition, we run other critical services the above services interact with like `monerod`, `monero-lws`, `postgres`, `opensearch`, and `media`/`seaweedfs` (the S3-compatible media store: an HTTP-only Caddy proxy in front of a SeaweedFS backend — the `media` service carries the legacy `minio` network alias so old internal `http://minio:9000/uploads/...` URLs keep resolving).

### Media store configuration

The SeaweedFS backend boots only with a rendered, secret-bearing `s3.config.json`
(admin identity from `MEDIA_AWS_*`, plus anonymous `Read:<bucket>` — nothing
else). Before the first `up` with the `media` profile — render from the
EFFECTIVE environment (local `.env.local` overrides win over tracked
defaults):

```sh
mkdir -p .media-runtime && chmod 700 .media-runtime
set -a; source .env.development; [ -f .env.local ] && source .env.local; set +a
node scripts/render-media-config.cjs .media-runtime/s3.config.json
docker compose --profile media up -d media seaweedfs
docker compose exec -w /app app node scripts/ensure-media-bucket.cjs
```

`.media-runtime/` is gitignored and must never be committed. The backend fails
closed if the config is missing.

<br>

## Wallet transaction safety

To ensure stashers balances are kept sane, some wallet updates are run in [serializable transactions](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-SERIALIZABLE) at the database level. Because early versions of prisma had relatively poor support for transactions most wallet touching code is written in [plpgsql](https://www.postgresql.org/docs/current/plpgsql.html) stored procedures and can be found in the `prisma/migrations` folder.

*UPDATE*: Most wallet updates are now run in [read committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED) transactions. See `api/payIn/README.md` for more information.

<br>

# Need help?
Open a [discussion](http://github.com/stashernews/stasher-news/discussions) or [issue](http://github.com/stashernews/stasher-news/issues/new).

<br>

# Responsible disclosure

If you found a vulnerability, we would greatly appreciate it if you open a [security advisory](https://github.com/stashernews/stasher-news/security/advisories/new). Our PGP key can be found [here](https://stasher.news/pgp.txt) (D1DB C80D 2155 2EB3 D549 08EB 3EC2 64CE B2B8 3AC4).

<br>

# License
[MIT](https://choosealicense.com/licenses/mit/)
