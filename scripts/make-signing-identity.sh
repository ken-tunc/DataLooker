#!/usr/bin/env bash
set -euo pipefail

# Make the code-signing identity `vp run tauri build` signs this app with, or
# say nothing if it is already there. `KEYCHAIN` says where it goes, and a
# keychain that is not there yet is one this script makes, unlocks and puts in
# the search list — which is what a build machine needs and what a reader's own
# login keychain already is.
#
# Nobody trusts this certificate, and that is not what it is for: what a stable
# signature buys is the keychain and the privacy permissions the reader grants
# the app, which macOS keys to the signature rather than to the path. Signed by
# the linker alone, every build is a different app to them, and the app is
# asked about again.
#
# The certificate is the keychain's rather than the repository's, so the one a
# build machine makes goes away with the machine and every published build is
# signed by a different one. That is the price of keeping no key anywhere: a
# reader who downloads two releases answers for both. Putting one certificate
# in the repository's secrets and importing it here instead is what would end
# that, and is worth doing when somebody is bothered by it.

NAME="DataLooker Self-Signed"
KEYCHAIN="${KEYCHAIN:-${HOME}/Library/Keychains/login.keychain-db}"

# Asked of that keychain rather than of the search list: which keychain holds
# it is what decides whether this has anything to do. Read into the test rather
# than piped through grep, which under `pipefail` can answer for the signal it
# sent `security` by closing the pipe on it.
if [[ -f "${KEYCHAIN}" && "$(security find-identity -p codesigning "${KEYCHAIN}")" == *"${NAME}"* ]]; then
  echo "${NAME} is already in ${KEYCHAIN}."
  exit 0
fi

# macOS's own openssl, rather than whichever one is on PATH: a PKCS#12 file
# written with the defaults of a newer OpenSSL is one the keychain refuses to
# read.
openssl=/usr/bin/openssl

made_keychain=false
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
# It guards a file that lives in a directory only this user can read and is
# gone when the script ends; what it is not guarding is the key, which the
# keychain has by then.
password="$("${openssl}" rand -base64 24)"

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

if [[ ! -f "${KEYCHAIN}" ]]; then
  security create-keychain -p "${password}" "${KEYCHAIN}"
  # No auto-lock: a build takes longer than the timeout a keychain starts with,
  # and a locked keychain is a signature that does not happen.
  security set-keychain-settings "${KEYCHAIN}"
  security unlock-keychain -p "${password}" "${KEYCHAIN}"
  security list-keychains -d user -s "${KEYCHAIN}" login.keychain-db
  made_keychain=true
fi

# `-T` is what lets codesign reach the key without asking for a password every
# build.
security import "${work}/codesign.p12" -k "${KEYCHAIN}" -P "${password}" -T /usr/bin/codesign

if [[ "${made_keychain}" == true ]]; then
  # Saying which tools may use the key without asking. A keychain the reader
  # already had is left alone: this needs its password, and signing works
  # there without it.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "${password}" "${KEYCHAIN}" > /dev/null
fi

# What ran this is a workflow, so the steps after it know what to sign with.
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY=${NAME}" >> "${GITHUB_ENV}"
fi

cat <<'NOTE'

Built it. Sign a build with it by naming it:

    APPLE_SIGNING_IDENTITY="DataLooker Self-Signed" vp run tauri build

Nothing trusts the certificate, so `security find-identity -v` will not list
it and Gatekeeper will not accept a build on another Mac. Neither is what it
is for. Undo all of this by deleting the certificate in Keychain Access.
NOTE
