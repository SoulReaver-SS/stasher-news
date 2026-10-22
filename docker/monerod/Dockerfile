# madebytimo/monerod v0.1.2-2026.10.22 bundles the official monerod
# v0.18.5.4 'Fluorine Fermi' linux-x64 binary. Hash chain verified 2026-10-22:
# release tarball sha256 ba2928962c101b609434bf8c1b43ad59ebe96c5525977284ca599d8bf0f02d10
# equals the value in the GPG-signed release hash list (getmonero.org over TLS);
# the tarball's extracted monerod and the image's /opt/monero/monerod are both
# sha256 f035a7c555aec692705012027a64707f38adeabc4a4c9244f259cd78bb2e84f1
# (bit-identical). Candidate image digest:
# sha256:829a499fd40beb93d08f5928baf302d4b121e292f13c8a0d1883bc45f0e539b9.
# Verify in a built image: /opt/monero/monerod --version
# Tag scheme is the image's own version + build date, NOT the monero version —
# bump deliberately and re-check --version whenever this tag changes.
FROM madebytimo/monerod:v0.1.2-2026.10.22

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
