FROM ghcr.io/vtnerd/monero-lws:v1.0.4@sha256:1f9a7eceb84b8a681a58378800e251a2356f9fb7947632bf0e7f0a2fa2e3348b

USER root

RUN command -v openssl >/dev/null 2>&1 || \
    (apt-get update && apt-get install -y --no-install-recommends openssl \
     && rm -rf /var/lib/apt/lists/*)

RUN command -v curl >/dev/null 2>&1 || \
    (apt-get update && apt-get install -y --no-install-recommends curl \
     && rm -rf /var/lib/apt/lists/*)

RUN mkdir -p /keys && chown monero-lws:monero-lws /keys

COPY gen-keys.sh   /usr/local/bin/gen-keys.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/gen-keys.sh /usr/local/bin/entrypoint.sh

USER monero-lws
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
