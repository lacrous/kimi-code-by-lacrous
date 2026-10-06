#!/usr/bin/env bash
#
# Installer for the lacrous fork of Kimi Code CLI (@lacrous/kimi-code).
#
# Installs the published npm package into a self-contained prefix and exposes
# it as the `lacrous-kimi` command, so it never collides with a `kimi` already
# on PATH (upstream's CLI, or a prebuilt native binary).
#
# Usage:
#   ./install.sh
#   ./install.sh --version 2.2.0-lacrous.0
#   ./install.sh --prefix "$HOME/.local/share/lacrous-kimi"
#   ./install.sh --bin-dir /usr/local/bin
#
# Optional env (flags win when both are given):
#   KIMI_VERSION            npm version to install (default: latest)
#   LACROUS_PREFIX          install prefix (default: ~/.local/share/lacrous-kimi)
#   LACROUS_BIN_DIR         directory for the `lacrous-kimi` launcher (default: ~/.local/bin)
#   LACROUS_NO_MODIFY_PATH  skip PATH modification when non-empty

set -euo pipefail

readonly PACKAGE="@lacrous/kimi-code"
readonly SHORTCUT="lacrous-kimi"

KIMI_VERSION="${KIMI_VERSION:-}"
LACROUS_PREFIX="${LACROUS_PREFIX:-$HOME/.local/share/lacrous-kimi}"
LACROUS_BIN_DIR="${LACROUS_BIN_DIR:-$HOME/.local/bin}"
LACROUS_NO_MODIFY_PATH="${LACROUS_NO_MODIFY_PATH:-}"

# Populated by the helpers below.
NODE_BIN=""
ENTRY=""
IS_BIN_ON_PATH=""
PATH_UPDATED_RC=""

# ---------- helpers ----------

_have() { command -v "$1" >/dev/null 2>&1; }

_log() {
  if [ -t 1 ]; then
    printf '\033[1;36m==>\033[0m %s\n' "$*"
  else
    printf '==> %s\n' "$*"
  fi
}

_warn() {
  if [ -t 1 ]; then
    printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2
  else
    printf 'warning: %s\n' "$*" >&2
  fi
}

_err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

_usage() {
  cat <<'EOF'
Install the lacrous fork of Kimi Code CLI (@lacrous/kimi-code).

Usage:
  ./install.sh [options]

Options:
  --version VERSION    npm version to install (default: latest)
  --prefix DIR         install prefix (default: ~/.local/share/lacrous-kimi)
  --bin-dir DIR        directory for the `lacrous-kimi` launcher (default: ~/.local/bin)
  -h, --help           show this help

Environment:
  KIMI_VERSION            same as --version
  LACROUS_PREFIX          same as --prefix
  LACROUS_BIN_DIR         same as --bin-dir
  LACROUS_NO_MODIFY_PATH  skip PATH modification when set
EOF
}

_parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help)
        _usage
        exit 0
        ;;
      --version)
        [ -n "${2:-}" ] || _err "--version requires a value"
        KIMI_VERSION="$2"
        shift 2
        ;;
      --version=*)
        KIMI_VERSION="${1#--version=}"
        [ -n "$KIMI_VERSION" ] || _err "--version requires a value"
        shift
        ;;
      --prefix)
        [ -n "${2:-}" ] || _err "--prefix requires a value"
        LACROUS_PREFIX="$2"
        shift 2
        ;;
      --prefix=*)
        LACROUS_PREFIX="${1#--prefix=}"
        [ -n "$LACROUS_PREFIX" ] || _err "--prefix requires a value"
        shift
        ;;
      --bin-dir)
        [ -n "${2:-}" ] || _err "--bin-dir requires a value"
        LACROUS_BIN_DIR="$2"
        shift 2
        ;;
      --bin-dir=*)
        LACROUS_BIN_DIR="${1#--bin-dir=}"
        [ -n "$LACROUS_BIN_DIR" ] || _err "--bin-dir requires a value"
        shift
        ;;
      -*)
        _err "unknown option: $1"
        ;;
      *)
        _err "unexpected extra argument: $1 (use --version VERSION)"
        ;;
    esac
  done
}

_detect_platform() {
  case "$(uname -s)" in
    Darwin) : ;;
    Linux) : ;;
    MINGW*|MSYS*|CYGWIN*)
      _err "Windows is not supported by install.sh — use npm/pnpm directly, or install.ps1"
      ;;
    *) _err "unsupported OS: $(uname -s)" ;;
  esac
}

_require_node() {
  _have node || _err "Node.js is required but was not found on PATH. Install Node.js >= 22.19.0 first."
  NODE_BIN="$(command -v node)"

  local major minor
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  minor="$("$NODE_BIN" -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"

  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 19 ]; }; then
    _err "Node.js >= 22.19.0 is required (found $("$NODE_BIN" --version)). Install a newer Node.js first."
  fi
  _log "Using Node.js $("$NODE_BIN" --version) at $NODE_BIN"
}

_choose_installer() {
  if _have npm; then
    printf 'npm'
  elif _have pnpm; then
    printf 'pnpm'
  else
    _err "neither npm nor pnpm was found on PATH. Install one of them first."
  fi
}

_resolve_entry() {
  local candidate
  candidate="$LACROUS_PREFIX/lib/node_modules/@lacrous/kimi-code/dist/main.mjs"
  [ -f "$candidate" ] || _err "installed entry point not found at $candidate"
  ENTRY="$candidate"
}

_install_package() {
  local installer="$1" pkg_target
  if [ -n "$KIMI_VERSION" ]; then
    pkg_target="${PACKAGE}@${KIMI_VERSION}"
  else
    pkg_target="${PACKAGE}@latest"
  fi
  _log "Installing ${pkg_target} into ${LACROUS_PREFIX}/lib (via ${installer})"
  mkdir -p "$LACROUS_PREFIX/lib"
  case "$installer" in
    npm)
      npm_config_update_notifier=false npm install --prefix "$LACROUS_PREFIX/lib" \
        --no-save --no-fund --no-audit --prefer-offline --loglevel=error "$pkg_target" \
        || _err "npm install failed for ${pkg_target}"
      ;;
    pnpm)
      if [ ! -f "$LACROUS_PREFIX/lib/package.json" ]; then
        printf '{ "name": "lacrous-kimi-prefix", "private": true }\n' \
          > "$LACROUS_PREFIX/lib/package.json"
      fi
      pnpm add --dir "$LACROUS_PREFIX/lib" --ignore-workspace "$pkg_target" \
        || _err "pnpm add failed for ${pkg_target}"
      ;;
  esac
}

_write_launcher() {
  mkdir -p "$LACROUS_BIN_DIR"
  local launcher="${LACROUS_BIN_DIR}/${SHORTCUT}"
  cat > "$launcher" <<EOF
#!/bin/sh
exec "${NODE_BIN}" "${ENTRY}" "\$@"
EOF
  chmod +x "$launcher"
  _log "Created launcher ${launcher}"
}

_path_contains() {
  local dir="$1" entry
  local IFS=':'
  for entry in $PATH; do
    if [ "$entry" = "$dir" ]; then
      return 0
    fi
  done
  return 1
}

_update_path() {
  if _path_contains "$LACROUS_BIN_DIR"; then
    IS_BIN_ON_PATH=1
    return
  fi
  IS_BIN_ON_PATH=0
  if [ -n "$LACROUS_NO_MODIFY_PATH" ]; then
    return
  fi

  local shell_name rc="" candidate
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    bash)
      for candidate in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$candidate" ]; then
          rc="$candidate"
          break
        fi
      done
      ;;
    zsh) rc="$HOME/.zshrc" ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *)
      if [ -f "$HOME/.bashrc" ]; then
        rc="$HOME/.bashrc"
      fi
      ;;
  esac
  if [ -z "$rc" ]; then
    rc="$HOME/.profile"
  fi

  local guard="# added by the lacrous kimi installer"
  if grep -qF "$guard" "$rc" 2>/dev/null; then
    _log "${LACROUS_BIN_DIR} already referenced in ${rc}; leaving it untouched"
    return
  fi

  mkdir -p "$(dirname "$rc")"
  if [ "$shell_name" = "fish" ]; then
    printf '\n%s\nset -gx PATH %s $PATH\n' "$guard" "$LACROUS_BIN_DIR" >> "$rc"
  else
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$guard" "$LACROUS_BIN_DIR" >> "$rc"
  fi
  PATH_UPDATED_RC="$rc"
  _log "Added ${LACROUS_BIN_DIR} to PATH in ${rc}"
}

_verify() {
  local launcher="${LACROUS_BIN_DIR}/${SHORTCUT}" out=""
  [ -x "$launcher" ] || _err "launcher not found at ${launcher}"

  if out="$("$launcher" --version 2>&1)"; then
    _log "Verified ${SHORTCUT} --version -> $(printf '%s' "$out" | tr -d '\r' | tail -n 1)"
  else
    _warn "could not verify ${SHORTCUT} --version:"
    printf '%s\n' "$out" >&2
  fi
}

main() {
  _parse_args "$@"
  _detect_platform
  _require_node

  local installer
  installer="$(_choose_installer)"

  _install_package "$installer"
  _resolve_entry
  _write_launcher
  _update_path
  _verify

  _log "Done. Run: ${SHORTCUT}"

  if [ "$IS_BIN_ON_PATH" != "1" ]; then
    if [ -n "$PATH_UPDATED_RC" ]; then
      _log "If ${SHORTCUT} is not found, restart your shell or run: source ${PATH_UPDATED_RC}"
    else
      _warn "${LACROUS_BIN_DIR} is not on your PATH. Add it, then run: ${SHORTCUT}"
      printf '    export PATH="%s:$PATH"\n' "$LACROUS_BIN_DIR" >&2
    fi
  fi
}

main "$@"