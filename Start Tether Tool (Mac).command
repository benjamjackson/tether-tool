#!/bin/bash
# Double-click this file to start Tether Tool on a Mac.
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

echo "Starting Tether Tool..."
npm start || fail
