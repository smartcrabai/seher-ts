#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

bun install
bun run build

cd packages/cli
bun link

echo
echo "Linked: $(readlink -f "$HOME/.bun/bin/seher" 2>/dev/null || readlink "$HOME/.bun/bin/seher")"
