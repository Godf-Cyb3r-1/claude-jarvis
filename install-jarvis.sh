#!/usr/bin/env bash
# Install the latest Jarvis build for Linux into ~/.local/bin (override with JARVIS_PREFIX).
set -euo pipefail
REPO="${JARVIS_REPO:-Godf-Cyb3r-1/claude-jarvis}"
PREFIX="${JARVIS_PREFIX:-$HOME/.local/bin}"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
# Older x86 CPUs without AVX2 need the baseline build.
if [ "$ARCH" = x64 ] && ! grep -q avx2 /proc/cpuinfo 2>/dev/null; then ARCH=x64-baseline; fi
URL="https://github.com/$REPO/releases/download/jarvis-latest"
mkdir -p "$PREFIX"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading jarvis-linux-$ARCH ..."
curl -fL --progress-bar "$URL/jarvis-linux-$ARCH" -o "$TMP/jarvis"
curl -fsSL "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
( cd "$TMP" && grep " jarvis-linux-$ARCH\$" SHA256SUMS | sed "s/jarvis-linux-$ARCH/jarvis/" | sha256sum -c - )
install -m 0755 "$TMP/jarvis" "$PREFIX/jarvis"
echo "Installed to $PREFIX/jarvis"
case ":$PATH:" in *":$PREFIX:"*) ;; *) echo "Add to PATH:  export PATH=\"$PREFIX:\$PATH\"" ;; esac
command -v opencode >/dev/null 2>&1 || echo "opencode not found. Install it first:  curl -fsSL https://opencode.ai/install | bash"
echo "Run:  cd your-project && jarvis    (then open http://127.0.0.1:4747)"
