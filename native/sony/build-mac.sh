#!/bin/bash
# Builds the Sony tether helper on a Mac. Needs Apple's Command Line Tools
# (the launcher offers to install them). Rebuilds only when the source changed.
set -euo pipefail
cd "$(dirname "$0")"

BIN=bin
EXE="$BIN/sony-tether"

if [ -x "$EXE" ] && [ "$EXE" -nt sony-tether.cpp ] && [ "$EXE" -nt build-mac.sh ]; then
  exit 0
fi

mkdir -p "$BIN/Contents/Frameworks/CrAdapter"
cp sdk/mac/*.dylib "$BIN/"
cp sdk/mac/CrAdapter/*.dylib "$BIN/Contents/Frameworks/CrAdapter/"

clang++ -std=c++17 -O2 -mmacosx-version-min=12.1 \
  -I sdk/include sony-tether.cpp \
  -L sdk/mac -lCr_Core -Wl,-rpath,@executable_path \
  -o "$EXE"

# Files unzipped from a download are marked as quarantined, which stops
# macOS from loading Sony's libraries. They come from Sony's kit in this repo.
xattr -cr "$BIN" 2>/dev/null || true
echo "Built $EXE"
