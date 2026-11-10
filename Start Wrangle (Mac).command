#!/bin/bash
# Double-click this file to start Wrangle on a Mac.
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

fail() {
  echo
  echo "Something went wrong. Take a screenshot of this window and send it to Claude."
  read -r -p "Press Return to close."
  exit 1
}

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and try again."
  read -r -p "Press Return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First start: downloading what the app needs. This takes a minute or two..."
  npm install || fail
fi

# Sony tethering needs a small helper built on this Mac with Apple's free
# Command Line Tools. Without them the app still runs, just without Sony control.
if [ -f native/sony/build-mac.sh ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "Sony tethering needs Apple's Command Line Tools."
    echo "A window will open: click Install, wait for it to finish, then double-click this file again."
    xcode-select --install >/dev/null 2>&1 || true
    read -r -p "Press Return to start Wrangle without Sony tethering for now."
  else
    bash native/sony/build-mac.sh || echo "Sony tethering could not be set up. The app will still start; send Claude a screenshot of this window."
  fi
fi

echo "Starting Wrangle..."
npm start || fail
