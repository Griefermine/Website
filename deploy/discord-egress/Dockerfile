# Pinned by digest (image index, verifiziert 2026-10-22 gegen Registry und
# Hub-API, Tag bookworm-slim, Multi-Arch inkl. linux/amd64). Ein Upgrade ist
# bewusst Handarbeit: Base-Image nur gegen einen geprüften neuen Digest
# tauschen, niemals auf einen beweglichen Tag zurückschalten.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

RUN apt-get update \
    && apt-get install -y --no-install-recommends squid ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=root:root --chmod=0444 squid.conf /etc/squid/squid.conf

USER proxy
EXPOSE 3128
ENTRYPOINT ["squid", "-N", "-f", "/etc/squid/squid.conf"]
