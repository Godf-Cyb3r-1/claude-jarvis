#!/usr/bin/env bash
# Install the latest Jarvis build for Linux into ~/.local/bin (override with JARVIS_PREFIX).
# Also installs a pinned opencode server into ~/.local/share/jarvis/bin. The default, 1.18.33, still
# serves unlimited free models; 2.x has a metered free tier. Override with OPENCODE_VERSION, skip with
# JARVIS_SKIP_OPENCODE=1.
set -euo pipefail
REPO="${JARVIS_REPO:-Godf-Cyb3r-1/claude-jarvis}"
PREFIX="${JARVIS_PREFIX:-$HOME/.local/bin}"
PINNED_OPENCODE=1.18.33
OPENCODE_VERSION="${OPENCODE_VERSION:-$PINNED_OPENCODE}"
DATA="${JARVIS_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/jarvis}"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
# Older x86 CPUs without AVX2 need the baseline build.
if [ "$ARCH" = x64 ] && ! grep -q avx2 /proc/cpuinfo 2>/dev/null; then ARCH=x64-baseline; fi
URL="https://github.com/$REPO/releases/download/jarvis-latest"
mkdir -p "$PREFIX" "$DATA/bin"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading jarvis-linux-$ARCH ..."
curl -fL --progress-bar "$URL/jarvis-linux-$ARCH" -o "$TMP/jarvis"
curl -fsSL "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
( cd "$TMP" && grep " jarvis-linux-$ARCH\$" SHA256SUMS | sed "s/jarvis-linux-$ARCH/jarvis/" | sha256sum -c - )
install -m 0755 "$TMP/jarvis" "$PREFIX/jarvis"

if [ "${JARVIS_SKIP_OPENCODE:-0}" != "1" ]; then
  echo "Downloading opencode $OPENCODE_VERSION for linux-$ARCH ..."
  got=""
  if [ "$OPENCODE_VERSION" = "$PINNED_OPENCODE" ]; then
    # The release republishes the exact pinned build, including the baseline (no-AVX2) variant.
    if curl -fsSL "$URL/opencode-linux-$ARCH" -o "$TMP/opencode" 2>/dev/null; then
      if grep -q " opencode-linux-$ARCH\$" "$TMP/SHA256SUMS"; then
        ( cd "$TMP" && grep " opencode-linux-$ARCH\$" SHA256SUMS | sed "s/opencode-linux-$ARCH/opencode/" | sha256sum -c - )
      fi
      got=1
    fi
  fi
  if [ -z "$got" ]; then
    curl -fL --progress-bar "https://github.com/sst/opencode/releases/download/v$OPENCODE_VERSION/opencode-linux-$ARCH.tar.gz" -o "$TMP/opencode.tar.gz"
    mkdir -p "$TMP/oc" && tar -xzf "$TMP/opencode.tar.gz" -C "$TMP/oc"
    mv "$TMP/oc/opencode" "$TMP/opencode"
  fi
  install -m 0755 "$TMP/opencode" "$DATA/bin/opencode"
  echo "Installed opencode $OPENCODE_VERSION to $DATA/bin/opencode (Jarvis prefers it over PATH)."
fi

echo "Installed to $PREFIX/jarvis"
case ":$PATH:" in *":$PREFIX:"*) ;; *) echo "Add to PATH:  export PATH=\"$PREFIX:\$PATH\"" ;; esac
if [ "${JARVIS_SKIP_OPENCODE:-0}" = "1" ]; then
  command -v opencode >/dev/null 2>&1 || echo "opencode not found. Install opencode first:  curl -fsSL https://opencode.ai/v2/install | bash"
fi
echo "Run:  cd your-project && jarvis    (then open http://127.0.0.1:4747)"
