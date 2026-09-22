#!/usr/bin/env bash
set -euo pipefail

# Make the code-signing identity `vp run tauri build` signs this app with, or
# say nothing if it is already there.
#
# Nobody trusts this certificate, and that is not what it is for: what a stable
# signature buys is the keychain and the privacy permissions the reader grants
# the app, which macOS keys to the signature rather than to the path. Signed by
# the linker alone, every build is a different app to them, and the app is
# asked about again. The certificate stays in this machine's keychain — it is
# one machine's answer to that, and there is nothing to share until this app is
# built somewhere else and handed out.

NAME="DataLooker Self-Signed"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning | grep -qF "${NAME}"; then
  echo "${NAME} is already in the keychain."
  exit 0
fi

# macOS's own openssl, rather than whichever one is on PATH: a PKCS#12 file
# written with the defaults of a newer OpenSSL is one the keychain refuses to
# read.
openssl=/usr/bin/openssl

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
password="$("${openssl}" rand -base64 24)"

# The password guards a file that lives in a directory only this user can read
# and is gone when the script ends; what it is not guarding is the key, which
# the keychain has by then.

# A leaf that may sign code and nothing else.
printf '%s\n' \
  '[req]' \
  'distinguished_name = dn' \
  'x509_extensions = v3' \
  'prompt = no' \
  '[dn]' \
  "CN = ${NAME}" \
  '[v3]' \
  'basicConstraints = critical,CA:false' \
  'keyUsage = critical,digitalSignature' \
  'extendedKeyUsage = critical,codeSigning' \
  > "${work}/codesign.cnf"

"${openssl}" req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "${work}/codesign.cnf" \
  -keyout "${work}/codesign.key" -out "${work}/codesign.crt"
"${openssl}" pkcs12 -export -name "${NAME}" \
  -inkey "${work}/codesign.key" -in "${work}/codesign.crt" \
  -out "${work}/codesign.p12" -passout "pass:${password}"

# `-T` is what lets codesign reach the key without asking the reader for their
# login password every build.
security import "${work}/codesign.p12" -k "${KEYCHAIN}" -P "${password}" -T /usr/bin/codesign

cat <<'NOTE'

Built it. Sign a build with it by naming it:

    APPLE_SIGNING_IDENTITY="DataLooker Self-Signed" vp run tauri build

Nothing trusts the certificate, so `security find-identity -v` will not list
it and Gatekeeper will not accept a build on another Mac. Neither is what it
is for. Undo all of this by deleting the certificate in Keychain Access.
NOTE
