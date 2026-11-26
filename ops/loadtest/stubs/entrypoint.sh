#!/bin/sh
# A throwaway CA and a certificate for api.paystack.co, made fresh on every start. The API and worker trust the CA
# through NODE_EXTRA_CA_CERTS (shared volume), so their real Paystack client talks TLS to this stub.
set -eu
cd "${STUB_CERT_DIR:-/certs}"
rm -f ca.* server.*
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=emma load-test stub CA" \
  -keyout ca.key -out ca.crt -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=api.paystack.co" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:api.paystack.co\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 7 -extfile server.ext -out server.crt 2>/dev/null
chmod 644 ca.crt
exec node /stub/server.mjs
