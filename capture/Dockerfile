FROM ghcr.io/puppeteer/puppeteer:25.16.0

# CVE-2026-111497 (Brotli decoder out-of-bounds write, CISA KEV since
# 2026-10-27): no puppeteer image tag ships a fixed Node yet. 25.16.0 (built
# 2026-10-22) still carries v24.21.0, so overlay the fixed Node toolchain from
# the official node image (same bookworm base, installs into /usr/local).
# Drop this COPY once a base tag's own Node passes the guard below.
COPY --from=node:24.22.1-bookworm /usr/local /usr/local

# fail the build loudly if the runtime Node is ever an unfixed line again
# (fixed: 22.23.4 / 24.22.1 / 26.12.1 or later on those lines; unknown future
# lines fail closed, extend the check when bumping onto them)
RUN node -e 'const [maj, min, pat] = process.versions.node.split(".").map(Number); const fixed = (maj === 22 && (min > 23 || (min === 23 && pat >= 4))) || (maj === 24 && (min > 22 || (min === 22 && pat >= 1))) || (maj === 26 && (min > 12 || (min === 12 && pat >= 1))); if (!fixed) { console.error("unfixed Node " + process.versions.node + " for CVE-2026-111497 (need >=22.23.4, >=24.22.1, or >=26.12.1)"); process.exit(1) }'

EXPOSE 5678

USER root
WORKDIR /home/pptruser

ENV PUPPETEER_SKIP_DOWNLOAD true
COPY ./package*.json ./
RUN npm ci

COPY . .

ADD https://deb.debian.org/debian/pool/main/f/fonts-noto-color-emoji/fonts-noto-color-emoji_0~20200916-1_all.deb fonts-noto-color-emoji.deb
RUN dpkg -i fonts-noto-color-emoji.deb
# images >= v22 dropped the google-chrome-stable apt package; Chrome-for-Testing
# lives in the pptruser cache. capture/index.js launches 'google-chrome-stable',
# so bridge it with a symlink (glob re-resolves at every image bump rebuild).
# The --version guard fails the build loudly if the cache layout ever drifts
# (a literal glob would otherwise build green while screenshots 500 silently).
RUN ln -s /home/pptruser/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome /usr/local/bin/google-chrome-stable && google-chrome-stable --version >/dev/null
CMD [ "node", "index.js" ]
USER pptruser
