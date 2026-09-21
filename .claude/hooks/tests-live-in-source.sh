#!/bin/sh
# A test belongs in the file it covers, behind `import.meta.vitest`. The one
# exception needs a real browser and has to be a file of its own. See CLAUDE.md.
#
# This refuses the file rather than explaining the rule afterwards, because a
# test in the wrong place is cheap to write and easy to miss in review.
set -eu

path=$(jq -r '.tool_input.file_path // empty')

case "$path" in
*.browser.test.tsx) exit 0 ;;
*.test.ts | *.test.tsx | *.spec.ts | *.spec.tsx)
	cat >&2 <<'WHY'
This repository keeps a test inside the file it covers, in an
`import.meta.vitest` block at the foot of it — nothing is exported for a
test's sake, and there is no second file to keep in step with the first.

Add the test to the source file instead. If it has to drive a component in a
real browser, name it `*.browser.test.tsx`.
WHY
	exit 2
	;;
esac
