#!/bin/sh
set -e

CERT_DIR="/etc/letsencrypt/live/aira.winnerx0.dev"

if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
        -keyout "$CERT_DIR/privkey.pem" \
        -out "$CERT_DIR/fullchain.pem" \
        -subj '/CN=aira.winnerx0.dev'
fi

exec nginx -g "daemon off;"
