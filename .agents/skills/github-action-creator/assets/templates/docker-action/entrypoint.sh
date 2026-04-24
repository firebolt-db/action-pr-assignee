#!/bin/sh
# `set -e` aborts on the first failing command. Without it, a failing
# intermediate command leaves the script running and the step exits 0 — a
# silent, common bug. Keep this line.
set -e

GREETING="$1"
WHO_TO_GREET="$2"

# Validate inputs explicitly rather than relying on `required: true` in the
# metadata — the latter does not enforce non-empty.
if [ -z "$WHO_TO_GREET" ]; then
  echo "::error::Input 'who-to-greet' is required"
  exit 1
fi

FULL_GREETING="${GREETING}, ${WHO_TO_GREET}!"
echo "$FULL_GREETING"

# Expose the result as a step output. Consumers read it via
#   ${{ steps.<id>.outputs.full-greeting }}
echo "full-greeting=${FULL_GREETING}" >> "$GITHUB_OUTPUT"
