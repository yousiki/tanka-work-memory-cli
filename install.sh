#!/usr/bin/env bash
# tanka-wm installer — download the latest (or pinned) release binary from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.sh | bash
#
# Environment variables:
#   TANKA_WM_VERSION      pin a specific version (e.g. v1.3.1); default: latest
#   TANKA_WM_INSTALL_DIR  install directory; default: ~/.local/bin
#   TANKA_WM_NO_MODIFY_PATH  set to 1 to skip PATH modification prompts
#
# Requirements: curl or wget, sha256sum or shasum, tar (none needed), unzip (none needed)
# The binary is a single self-contained file — no archive extraction required.

set -euo pipefail

# ── Color output (respect NO_COLOR / dumb terminal) ──────────────────

setup_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    RED='\033[31m'; GRN='\033[32m'; YLW='\033[33m'; BLU='\033[34m'
    BLD='\033[1m'; DIM='\033[2m'; RST='\033[0m'
  else
    RED=''; GRN=''; YLW=''; BLU=''; BLD=''; DIM=''; RST=''
  fi
}

info()  { printf "${BLU}info${RST}  %s\n" "$*"; }
ok()    { printf "${GRN}  ok${RST}  %s\n" "$*"; }
warn()  { printf "${YLW}warn${RST}  %s\n" "$*" >&2; }
error() { printf "${RED}error${RST} %s\n" "$*" >&2; }
die()   { error "$@"; exit 1; }

# ── Platform detection ───────────────────────────────────────────────

detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os=linux ;;
    Darwin*) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)   arch=x64 ;;
    aarch64|arm64)   arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  PLATFORM="${os}-${arch}"
  ASSET_NAME="tanka-wm-${PLATFORM}"
  if [ "$os" = "windows" ]; then
    ASSET_NAME="${ASSET_NAME}.exe"
  fi
}

# ── HTTP helpers (curl preferred, wget fallback) ─────────────────────

has_cmd() { command -v "$1" >/dev/null 2>&1; }

http_get() {
  local url="$1" dest="${2:-}"
  if has_cmd curl; then
    if [ -n "$dest" ]; then
      curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url"
    else
      curl -fsSL --retry 3 --retry-delay 2 "$url"
    fi
  elif has_cmd wget; then
    if [ -n "$dest" ]; then
      wget -qO "$dest" "$url"
    else
      wget -qO- "$url"
    fi
  else
    die "either curl or wget is required"
  fi
}

# ── Version resolution ───────────────────────────────────────────────

GITHUB_REPO="Shanda-Group-Ltd/tanka-work-memory-cli"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases"

resolve_version() {
  if [ -n "${TANKA_WM_VERSION:-}" ]; then
    VERSION="${TANKA_WM_VERSION}"
    # normalize: add v prefix if missing
    case "$VERSION" in
      v*) ;;
      *)  VERSION="v${VERSION}" ;;
    esac
    info "pinned version: ${VERSION}"
  else
    info "resolving latest version…"
    VERSION=$(http_get "${GITHUB_API}/latest" "" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    [ -n "$VERSION" ] || die "failed to resolve latest version from GitHub API"
    info "latest version: ${VERSION}"
  fi

  DOWNLOAD_BASE="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}"
}

# ── Checksum verification ────────────────────────────────────────────

verify_checksum() {
  local file="$1" expected_hash="$2"

  local actual_hash
  if has_cmd sha256sum; then
    actual_hash=$(sha256sum "$file" | cut -d' ' -f1)
  elif has_cmd shasum; then
    actual_hash=$(shasum -a 256 "$file" | cut -d' ' -f1)
  else
    warn "neither sha256sum nor shasum found — skipping checksum verification"
    return 0
  fi

  if [ "$actual_hash" != "$expected_hash" ]; then
    die "checksum mismatch for $(basename "$file")
  expected: ${expected_hash}
    actual: ${actual_hash}"
  fi
  ok "checksum verified"
}

# ── PATH helpers ─────────────────────────────────────────────────────

dir_in_path() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *)        return 1 ;;
  esac
}

detect_shell_profile() {
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/sh}")"
  case "$shell_name" in
    zsh)  echo "${HOME}/.zshrc" ;;
    bash)
      if [ -f "${HOME}/.bash_profile" ]; then
        echo "${HOME}/.bash_profile"
      else
        echo "${HOME}/.bashrc"
      fi
      ;;
    fish) echo "${HOME}/.config/fish/config.fish" ;;
    *)    echo "${HOME}/.profile" ;;
  esac
}

prompt_path_setup() {
  local install_dir="$1"
  if dir_in_path "$install_dir"; then
    return 0
  fi

  if [ "${TANKA_WM_NO_MODIFY_PATH:-}" = "1" ]; then
    warn "${install_dir} is not in your PATH"
    warn "add it manually: export PATH=\"${install_dir}:\$PATH\""
    return 0
  fi

  local profile
  profile="$(detect_shell_profile)"
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/sh}")"
  local line

  if [ "$shell_name" = "fish" ]; then
    line="fish_add_path ${install_dir}"
  else
    line="export PATH=\"${install_dir}:\$PATH\""
  fi

  warn "${install_dir} is not in your PATH"

  # Non-interactive (piped) — append automatically
  if [ ! -t 0 ]; then
    echo "" >> "$profile"
    echo "# tanka-wm" >> "$profile"
    echo "$line" >> "$profile"
    ok "added to ${profile} — restart your shell or run: source ${profile}"
    return 0
  fi

  # Interactive — ask
  printf "${YLW}?${RST} add to ${BLD}${profile}${RST}? [Y/n] "
  read -r answer </dev/tty
  case "$answer" in
    [nN]*) warn "skipped — add manually: ${line}" ;;
    *)
      echo "" >> "$profile"
      echo "# tanka-wm" >> "$profile"
      echo "$line" >> "$profile"
      ok "added to ${profile} — restart your shell or run: source ${profile}"
      ;;
  esac
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
  setup_colors

  printf "\n${BLD}tanka-wm installer${RST}\n\n"

  detect_platform
  info "platform: ${PLATFORM}"

  resolve_version

  local install_dir="${TANKA_WM_INSTALL_DIR:-${HOME}/.local/bin}"
  local bin_name="tanka-wm"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) bin_name="tanka-wm.exe" ;;
  esac
  local install_path="${install_dir}/${bin_name}"

  # Check for existing installation
  if [ -f "$install_path" ]; then
    local existing_ver
    existing_ver=$("$install_path" --version 2>/dev/null | awk '{print $2}' || echo "unknown")
    info "existing installation: ${existing_ver} at ${install_path}"
  fi

  # Create install directory
  mkdir -p "$install_dir" || die "failed to create ${install_dir}"

  # Download checksums
  TMPDIR_CLEANUP=$(mktemp -d)
  local tmpdir="$TMPDIR_CLEANUP"
  trap 'rm -rf "$TMPDIR_CLEANUP"' EXIT

  info "downloading checksums…"
  http_get "${DOWNLOAD_BASE}/checksums-sha256.txt" "${tmpdir}/checksums-sha256.txt" \
    || die "failed to download checksums — does ${VERSION} exist?"

  # Extract expected hash for our asset
  local expected_hash
  expected_hash=$(grep "  ${ASSET_NAME}$" "${tmpdir}/checksums-sha256.txt" | cut -d' ' -f1)
  [ -n "$expected_hash" ] || die "no checksum found for ${ASSET_NAME} in checksums-sha256.txt
available assets:
$(cat "${tmpdir}/checksums-sha256.txt" | sed 's/^/  /')"

  # Download binary
  info "downloading ${ASSET_NAME}…"
  http_get "${DOWNLOAD_BASE}/${ASSET_NAME}" "${tmpdir}/${ASSET_NAME}" \
    || die "failed to download ${ASSET_NAME}"

  # Verify checksum
  verify_checksum "${tmpdir}/${ASSET_NAME}" "$expected_hash"

  # Install
  mv "${tmpdir}/${ASSET_NAME}" "$install_path"
  chmod +x "$install_path"

  # macOS: strip quarantine attribute
  if [ "$(uname -s)" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$install_path" 2>/dev/null || true
  fi

  ok "installed ${VERSION} to ${install_path}"

  # Verify it runs
  local installed_ver
  if installed_ver=$("$install_path" --version 2>/dev/null); then
    ok "${installed_ver}"
  else
    warn "binary installed but failed to run — check your system compatibility"
  fi

  # PATH setup
  prompt_path_setup "$install_dir"

  printf "\n${GRN}${BLD}done!${RST} Run ${BLD}tanka-wm --help${RST} to get started.\n\n"
}

main "$@"
