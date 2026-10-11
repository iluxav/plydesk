#!/bin/sh
#
# plydesk installer.
#
#   curl -fsSL https://raw.githubusercontent.com/iluxav/plydesk/main/install.sh | sh
#
# Why this exists rather than a .dmg: the app is not notarised, and macOS
# quarantines anything a *browser* downloads, so a downloaded .dmg would be
# refused by Gatekeeper. curl sets no quarantine attribute, so an app installed
# this way launches normally. The trade is that you are trusting this script and
# the checksums it verifies, which is why it verifies them.
#
# On Linux it unpacks the app into ~/.local and adds a launcher entry, so one
# command works on any distro without asking for root.
#
# Environment:
#   PLYDESK_REPO     owner/repo to install from (default below)
#   PLYDESK_VERSION  a tag such as v0.1.0 (default: latest release)
#   PLYDESK_PREFIX   where the app goes (default: /Applications, else
#                    ~/Applications on macOS; ~/.local on Linux)
#   PLYDESK_BASE_URL where assets are fetched from (default: the GitHub release)

set -eu

REPO="${PLYDESK_REPO:-iluxav/plydesk}"
VERSION="${PLYDESK_VERSION:-latest}"
API="https://api.github.com/repos/$REPO/releases"

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

OS=$(uname -s)
case "$OS" in
  Darwin|Linux) ;;
  *) die "plydesk runs on macOS and Linux (this is $OS)." ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=aarch64 ;;
  x86_64)        ARCH=x86_64 ;;
  *)             die "unsupported architecture: $(uname -m)" ;;
esac

if [ "$OS" = "Linux" ] && [ "$ARCH" != "x86_64" ]; then
  die "plydesk is built for x86_64 Linux only for now (this is $(uname -m))."
fi

command -v curl >/dev/null 2>&1 || die "curl is required."
if command -v shasum >/dev/null 2>&1; then
  SHA256="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="sha256sum"
else
  die "shasum or sha256sum is required."
fi

# Resolve the release, and say which one, so an unexpected version is visible
# before anything is written.
if [ -n "${PLYDESK_BASE_URL:-}" ]; then
  TAG="${VERSION#latest}"; TAG="${TAG:-local}"
elif [ "$VERSION" = "latest" ]; then
  TAG=$(curl -fsSL "$API/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$TAG" ] || die "no published release in $REPO yet."
else
  TAG="$VERSION"
fi

if [ "$OS" = "Darwin" ]; then
  ASSET="plydesk-${TAG}-${ARCH}.tar.gz"
else
  ASSET="plydesk-${TAG}-linux-${ARCH}.tar.gz"
fi
BASE="${PLYDESK_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}"

say "plydesk $TAG ($OS $ARCH)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "  downloading $ASSET"
curl -fSL --progress-bar -o "$TMP/$ASSET" "$BASE/$ASSET" \
  || die "could not download $BASE/$ASSET"

# The checksum is not optional: this puts an executable on your machine.
say "  verifying checksum"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" \
  || die "could not download SHA256SUMS — refusing to install unverified."
WANT=$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -1)
[ -n "$WANT" ] || die "$ASSET is not listed in SHA256SUMS."
GOT=$($SHA256 "$TMP/$ASSET" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || die "checksum mismatch
  expected $WANT
  got      $GOT
Refusing to install."

say "  unpacking"
PKG="$TMP/pkg"
mkdir "$PKG"
tar -xzf "$TMP/$ASSET" -C "$PKG"

install_macos() {
  [ -d "$PKG/plydesk.app" ] || die "the archive did not contain plydesk.app"

  # /Applications when writable, otherwise the user's own — never sudo behind
  # your back.
  if [ -n "${PLYDESK_PREFIX:-}" ]; then
    DEST="$PLYDESK_PREFIX"
  elif [ -w /Applications ]; then
    DEST=/Applications
  else
    DEST="$HOME/Applications"
    warn "  /Applications is not writable, installing to $DEST"
  fi
  # Every branch, not just the fallback: a prefix that does not exist yet is a
  # perfectly reasonable thing to ask for.
  mkdir -p "$DEST" || die "cannot create $DEST"
  [ -w "$DEST" ] || die "$DEST is not writable"

  if [ -d "$DEST/plydesk.app" ]; then
    say "  replacing the existing install"
    rm -rf "$DEST/plydesk.app"
  fi
  mv "$PKG/plydesk.app" "$DEST/plydesk.app"

  # curl leaves no quarantine attribute, so this is belt and braces for anyone
  # who fetched the tarball with a browser instead.
  xattr -dr com.apple.quarantine "$DEST/plydesk.app" 2>/dev/null || true

  say ""
  say "Installed to $DEST/plydesk.app"
  # The app was called sshdesk until September 2026. Its settings carry over on
  # first launch; the old bundle is left for the user to remove.
  if [ -d "$DEST/sshdesk.app" ]; then
    warn "  The previous version is still at $DEST/sshdesk.app. Once plydesk has opened, remove it with:  rm -rf $DEST/sshdesk.app"
  fi
  say ""
  say "  open -a plydesk        # or find it in Launchpad"
  say ""
  say "It is not signed by Apple, so a browser download would have been blocked."
  say "Installed this way it just opens. To remove it:  rm -rf $DEST/plydesk.app"
}

# The archive is a prefix tree: bin/plydesk, lib/plydesk/ (the bundled
# plugins, which the app finds at <bin>/../lib/plydesk) and share/ (the
# launcher entry and icons).
install_linux() {
  [ -x "$PKG/bin/plydesk" ] || die "the archive did not contain bin/plydesk"

  # The user's own prefix — never sudo behind your back.
  DEST="${PLYDESK_PREFIX:-$HOME/.local}"
  mkdir -p "$DEST/bin" "$DEST/lib" "$DEST/share/applications" \
    || die "cannot create $DEST"
  [ -w "$DEST/bin" ] || die "$DEST/bin is not writable"

  if [ -e "$DEST/bin/plydesk" ]; then
    say "  replacing the existing install"
  fi

  # Replaced wholesale, so a plugin dropped from the release does not linger.
  rm -rf "$DEST/lib/plydesk"
  cp -R "$PKG/lib/plydesk" "$DEST/lib/plydesk"
  cp -R "$PKG/share/icons" "$DEST/share/"

  # Renamed into place rather than copied over: Linux refuses to write to a
  # binary that is running ("Text file busy"), but replacing its name is fine.
  cp "$PKG/bin/plydesk" "$DEST/bin/.plydesk.new"
  mv -f "$DEST/bin/.plydesk.new" "$DEST/bin/plydesk"

  # The launcher runs this binary, not whatever `plydesk` is first on its PATH.
  {
    grep -v '^Exec=' "$PKG/share/applications/plydesk.desktop"
    printf 'Exec="%s"\n' "$DEST/bin/plydesk"
  } > "$DEST/share/applications/plydesk.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DEST/share/applications" 2>/dev/null || true
  fi

  say ""
  say "Installed to $DEST/bin/plydesk"

  # The app uses the system's WebKitGTK rather than carrying its own, so a
  # missing library is named here instead of surfacing as a failed launch.
  MISSING=$(ldd "$DEST/bin/plydesk" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')
  if [ -n "$MISSING" ]; then
    warn ""
    warn "  It will not start yet — missing: $MISSING"
    warn "  Install WebKitGTK 4.1:"
    warn "    Arch:           sudo pacman -S webkit2gtk-4.1"
    warn "    Debian/Ubuntu:  sudo apt install libwebkit2gtk-4.1-0"
    warn "    Fedora:         sudo dnf install webkit2gtk4.1"
  fi

  case ":$PATH:" in
    *":$DEST/bin:"*) ;;
    *) warn "  $DEST/bin is not on your PATH; the launcher entry works regardless." ;;
  esac

  say ""
  say "  plydesk               # or find it in your app launcher"
  say ""
  say "To remove it:"
  say "  rm -rf $DEST/bin/plydesk $DEST/lib/plydesk $DEST/share/applications/plydesk.desktop $DEST/share/icons/hicolor/*/apps/plydesk.png"
}

if [ "$OS" = "Darwin" ]; then
  install_macos
else
  install_linux
fi
