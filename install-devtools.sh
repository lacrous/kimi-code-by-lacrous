#!/usr/bin/env bash
#
# Installs everything needed to run this fork with computer control.
#
# Author: lacrous. Forks MoonshotAI/kimi-code; see CREDITS.md.
#
# This installs into the current checkout. It does not touch an already
# installed kimi (e.g. ~/.kimi-code) and does not write outside the machine
# paths named here.
#
#   ./install.sh              install tools + build the CLI from this checkout
#   ./install.sh --tools      only install the computer-use tools
#   ./install.sh --no-build   install tools, skip the pnpm build
#   ./install.sh --check      report what is present and missing, change nothing
#   ./install.sh --vm         also create the disposable VM (needs KVM)
#
# Computer control stays behind an experimental flag and is off by default:
#   export KIMI_CODE_EXPERIMENTAL_COMPUTER_USE=1
#   pnpm run kimi

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_PREFIX="${KIMI_TOOL_PREFIX:-$HOME/.local/opt/kimi-computer-tools}"

MIN_NODE_MAJOR=24
MIN_NODE_MINOR=15
REQUIRED_PNPM="10.33.0"

# Ubuntu 26.04 uses imagemagick-7.q16; older releases name it differently.
IMAGEMAGICK_PKG=""
for candidate in imagemagick-7.q16 imagemagick-6.q16 imagemagick; do
  if apt-cache show "$candidate" >/dev/null 2>&1; then
    IMAGEMAGICK_PKG="$candidate"
    break
  fi
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# The engines field says ">=24.15.0", so 26 must pass. Comparing against a
# pinned major would reject every newer runtime the user happens to have.
check_node_version() {
  local version major minor
  version="$(node -v)"
  major="$(printf '%s' "$version" | sed 's/^v//' | cut -d. -f1)"
  minor="$(printf '%s' "$version" | sed 's/^v//' | cut -d. -f2)"

  [ -n "$major" ] || die "could not parse the Node.js version from '$version'"

  if [ "$major" -gt "$MIN_NODE_MAJOR" ]; then
    return 0
  fi
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required (found $version)"
  fi
  if [ "$minor" -lt "$MIN_NODE_MINOR" ]; then
    die "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required (found $version)"
  fi
}

ONLY_TOOLS=0
DO_BUILD=1
CHECK_ONLY=0
WITH_VM=0

for arg in "$@"; do
  case "$arg" in
    --tools)    ONLY_TOOLS=1 ;;
    --no-build) DO_BUILD=0 ;;
    --check)    CHECK_ONLY=1 ;;
    --vm)       WITH_VM=1 ;;
    -h|--help)  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

TOOL_NAMES=(xdotool wmctrl import xwd xrandr)

report() {
  log "environment"
  printf '  node         %s\n' "$(node -v 2>/dev/null || echo MISSING)"
  printf '  pnpm         %s\n' "$(pnpm -v 2>/dev/null || echo MISSING)"
  printf '  kimi (this)  %s\n' "$(cd "$REPO_ROOT" && node ./scripts/kimi-dev.mjs --version 2>/dev/null | tail -1 || echo 'not built')"

  log "computer-use tools"
  local missing=0
  for tool in "${TOOL_NAMES[@]}"; do
    if have "$tool" || [ -x "$TOOL_PREFIX/bin/$tool" ]; then
      printf '  %-10s present\n' "$tool"
    else
      printf '  %-10s MISSING\n' "$tool"
      missing=1
    fi
  done

  log "browser"
  if [ -x "$HOME/.cache/ms-playwright" ] || ls "$HOME/.cache/ms-playwright"/*/chrome-linux64/chrome >/dev/null 2>&1; then
    printf '  chromium     present (playwright cache)\n'
  elif have chromium || have google-chrome; then
    printf '  chromium     present (system)\n'
  else
    printf '  chromium     MISSING — browser control will not start a browser\n'
    missing=1
  fi

  log "virtualization"
  if [ ! -e /dev/kvm ]; then
    printf '  /dev/kvm     absent — the VM will be very slow under emulation\n'
  elif [ "$(id -nG)" != *" kvm "* ] && [ "$(id -nG)" != "kvm "* ]; then
    # Group membership, not -w: the device carries an ACL, so a non-member
    # still passes the permission test while qemu still refuses to open it.
    printf '  /dev/kvm     present, but %s is not in the kvm group\n' "$(id -un)"
    printf '                sudo usermod -aG kvm %s   (then log out and back in)\n' "$(id -un)"
  else
    printf '  /dev/kvm     usable — the VM can use hardware acceleration\n'
  fi

  return "$missing"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  report || true
  exit 0
fi

install_tools_system() {
  log "installing computer-use tools via apt"

  # `imagemagick` is a metapackage; the real binaries live in the versioned
  # package, and its name varies by release.
  local packages=(
    xdotool
    wmctrl
    x11-apps
    x11-xserver-utils
  )
  [ -n "$IMAGEMAGICK_PKG" ] && packages+=("$IMAGEMAGICK_PKG")

  if have sudo && sudo -n true 2>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y "${packages[@]}"
    return 0
  fi

  # No passwordless sudo: fetch and unpack into a user-local prefix instead of
  # asking for a password or failing.
  warn "no passwordless sudo — installing to $TOOL_PREFIX instead"
  command -v apt-get >/dev/null 2>&1 || die "apt-get not found; install the tools manually"

  local work
  work="$(mktemp -d)"

  pushd "$work" >/dev/null
  apt-get download "${packages[@]}"
  mkdir -p root
  local deb
  for deb in ./*.deb; do
    dpkg-deb -x "$deb" root
  done
  popd >/dev/null

  mkdir -p "$TOOL_PREFIX/bin" "$TOOL_PREFIX/lib"
  cp -a "$work/root/usr/bin/." "$TOOL_PREFIX/bin/"
  if [ -d "$work/root/usr/lib" ]; then
    cp -a "$work/root/usr/lib/." "$TOOL_PREFIX/lib/"
  fi

  # ImageMagick names its binaries `import-im7.q16`; the tools expect `import`.
  if [ -x "$TOOL_PREFIX/bin/import-im7.q16" ] && [ ! -x "$TOOL_PREFIX/bin/import" ]; then
    cp "$TOOL_PREFIX/bin/import-im7.q16" "$TOOL_PREFIX/bin/import"
  fi

  # Drop everything the tools do not need, so the prefix stays small.
  find "$TOOL_PREFIX/bin" -maxdepth 1 -type f \
    ! -name xdotool ! -name wmctrl ! -name import ! -name xwd -delete 2>/dev/null || true

  rm -rf "$work"

  log "tools installed to $TOOL_PREFIX"
  log "add to your shell profile:"
  printf '  export PATH="%s/bin:$PATH"\n' "$TOOL_PREFIX"
  local libdir
  libdir="$(find "$TOOL_PREFIX/lib" -maxdepth 1 -type d -name 'x86_64*' | head -1)"
  if [ -n "$libdir" ]; then
    printf '  export LD_LIBRARY_PATH="%s:$LD_LIBRARY_PATH"\n' "$libdir"
  fi
}

verify_tools() {
  log "verifying tools"
  local path_suffix="" lib_suffix=""
  if [ -d "$TOOL_PREFIX/bin" ]; then
    path_suffix=":$TOOL_PREFIX/bin"
    local libdir
    libdir="$(find "$TOOL_PREFIX/lib" -maxdepth 1 -type d -name 'x86_64*' 2>/dev/null | head -1)"
    [ -n "$libdir" ] && lib_suffix=":$libdir"
  fi

  for tool in "${TOOL_NAMES[@]}"; do
    if have "$tool" || [ -x "$TOOL_PREFIX/bin/$tool" ]; then
      printf '  %-10s ok\n' "$tool"
    else
      warn "$tool not found"
    fi
  done

  # A real invocation is the only honest check: a binary can exist and still
  # fail on a missing shared library.
  if [ -n "$path_suffix" ] || [ -n "$lib_suffix" ]; then
    export PATH="${PATH}${path_suffix}"
    export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}${lib_suffix}"
  fi
  if have xdotool && have xrandr && [ -n "${DISPLAY:-}" ]; then
    if xdotool getdisplaygeometry >/dev/null 2>&1; then
      printf '  live check   xdotool reads the display: %s\n' "$(xdotool getdisplaygeometry)"
    else
      warn "xdotool could not read DISPLAY=${DISPLAY:-<unset>}"
    fi
  fi
}

install_node() {
  log "checking the Node.js toolchain"
  local major minor
  if ! have node; then
    die "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required but node was not found.
    Install it first (nvm, fnm, mise, or https://nodejs.org), then re-run."
  fi
  check_node_version

  if ! have pnpm; then
    log "installing pnpm ${REQUIRED_PNPM} via corepack"
    have corepack || die "pnpm is missing and corepack is unavailable. Install pnpm ${REQUIRED_PNPM}."
    corepack enable
    corepack prepare "pnpm@${REQUIRED_PNPM}" --activate
  fi

  local pnpm_version
  pnpm_version="$(pnpm -v)"
  [ "$pnpm_version" = "$REQUIRED_PNPM" ] || warn "pnpm ${pnpm_version} differs from the pinned ${REQUIRED_PNPM}"
}

build_kimi() {
  log "installing dependencies"
  (cd "$REPO_ROOT" && pnpm install)

  log "building packages"
  (cd "$REPO_ROOT" && pnpm run build:packages)

  log "building the CLI"
  (cd "$REPO_ROOT" && pnpm --filter @moonshot-ai/kimi-code run build)
}

create_vm() {
  log "checking virtualization support"
  KVM_FLAG=""
  if [ ! -e /dev/kvm ]; then
    warn "/dev/kvm is absent; the VM would run under slow software emulation."
    warn "On a nested-virt host that is often unavoidable. Continuing anyway."
  elif [ "$(id -nG)" != *" kvm "* ] && [ "$(id -nG)" != "kvm "* ]; then
    warn "$(id -un) is not in the kvm group, so qemu cannot open /dev/kvm."
    warn "The VM will run under software emulation and be slow."
    warn "Fix with: sudo usermod -aG kvm $(id -un)  (then log out and back in)"
    KVM_FLAG="-accel tcg,thread=multi"
  else
    printf '  /dev/kvm is usable — hardware acceleration enabled\n'
  fi

  have qemu-system-x86_64 || die "qemu-system-x86_64 is required for the VM (apt-get install qemu-system-x86)"

  local vm_dir="$REPO_ROOT/.vm"
  mkdir -p "$vm_dir"

  if [ -z "${KIMI_VM_ISO:-}" ]; then
    have curl || die "curl is required to download the ISO"

    # Ubuntu publishes point releases (24.04.3, 24.04.4, ...), so a hardcoded
    # filename 404s within months. Read the release index and take the newest.
    local index url filename
    index="$(curl -fsSL --retry 3 https://releases.ubuntu.com/24.04/)" \
      || die "could not read https://releases.ubuntu.com/24.04/"
    # The index links relative hrefs, so match the filename and build the URL.
    filename="$(printf '%s' "$index" \
      | grep -oE 'ubuntu-24\.04(\.[0-9]+)*-desktop-amd64\.iso' \
      | sort -uV | tail -1)"
    [ -n "$filename" ] || die "could not find a desktop ISO in the release index; set KIMI_VM_ISO to override"
    url="https://releases.ubuntu.com/24.04/$filename"
    filename="${url##*/}"
    log "downloading $filename"
    KIMI_VM_ISO="$vm_dir/$filename"

    if [ ! -f "$KIMI_VM_ISO" ]; then
      curl -fL --retry 3 --progress-bar -o "$KIMI_VM_ISO.part" "$url" \
        || die "ISO download failed: $url"
      mv "$KIMI_VM_ISO.part" "$KIMI_VM_ISO"
    fi
  fi

  [ -f "$KIMI_VM_ISO" ] || die "ISO not found at $KIMI_VM_ISO (set KIMI_VM_ISO to override)"

  log "creating the VM disk (40G sparse)"
  local disk="$vm_dir/kimi-vm.qcow2"
  [ -f "$disk" ] || qemu-img create -f qcow2 "$disk" 40G

  cat > "$vm_dir/run-vm.sh" <<EOF
#!/usr/bin/env bash
# Generated by install.sh --vm
set -euo pipefail
VM_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec qemu-system-x86_64 \\
  -name kimi-agent-vm \\
  -machine q35 \\
  -accel kvm \\
  ${KVM_FLAG:-} \\
  -cpu max \\
  -smp 4 \\
  -m 8192 \\
  -drive "file=\$VM_DIR/kimi-vm.qcow2,if=virtio,format=qcow2" \\
  -drive "file=$KIMI_VM_ISO,media=cdrom,readonly=on" \\
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \\
  -device virtio-net-pci,netdev=net0 \\
  -display gtk \\
  -vga std \\
  "\$@"
EOF
  chmod +x "$vm_dir/run-vm.sh"

  log "VM created in $vm_dir"
  printf '  disk         %s\n' "$disk"
  printf '  iso          %s\n' "$KIMI_VM_ISO"
  printf '  launcher     %s\n' "$vm_dir/run-vm.sh"
  printf '\n  Next: boot it once and install Ubuntu, then create a dedicated user:\n'
  printf '    %s\n' "$vm_dir/run-vm.sh"
  printf '    ssh -p 2222 <user>@localhost\n'
}

main() {
  printf '\nKimi Code (lacrous fork) installer\n'
  printf 'repository: %s\n\n' "$REPO_ROOT"

  install_tools_system
  verify_tools

  if [ "$ONLY_TOOLS" -eq 1 ]; then
    log "skipping the toolchain and build (--tools)"
  else
    install_node
    if [ "$DO_BUILD" -eq 1 ]; then
      build_kimi
    else
      log "skipping the build (--no-build)"
    fi
  fi

  if [ "$WITH_VM" -eq 1 ]; then
    create_vm
  fi

  log "done"
  printf '\nRun this fork with:\n'
  printf '  cd %s\n' "$REPO_ROOT"
  printf '  pnpm run kimi -- --version\n\n'
  printf 'Enable computer control (off by default):\n'
  printf '  export KIMI_CODE_EXPERIMENTAL_COMPUTER_USE=1\n\n'
  printf 'Check the installation at any time:\n'
  printf '  %s --check\n\n' "$0"
}

main "$@"