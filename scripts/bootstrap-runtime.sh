#!/usr/bin/env bash
# Source in the installer child. Runtime paths are returned through
# CC_GATEWAY_BUN and CC_GATEWAY_NODE; downloads never run before verification.

cc_gateway_runtime_error() {
    printf 'cc-gateway: %s\n' "$*" >&2
    return 1
}

cc_gateway_require_tools() {
    local tool
    for tool in "$@"; do
        command -v "$tool" >/dev/null 2>&1 || {
            cc_gateway_runtime_error "Required tool is missing: $tool. Install it and retry."
            return 1
        }
    done
}

cc_gateway_runtime_version_ok() {
    local kind=$1 version=$2
    [[ $version =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
    case $kind in
        bun) (( 10#${BASH_REMATCH[1]} > 1 || (10#${BASH_REMATCH[1]} == 1 && 10#${BASH_REMATCH[2]} >= 4) )) ;;
        node) (( 10#${BASH_REMATCH[1]} >= 24 )) ;;
        *) return 1 ;;
    esac
}

cc_gateway_private_owned_path() {
    local path=$1 mode owner
    [[ ! -L $path && -O $path ]] || return 1
    owner=$(stat -c '%u' -- "$path") || return 1
    mode=$(stat -c '%a' -- "$path") || return 1
    [[ $owner == "$EUID" && $mode =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 0022) == 0 ))
}

cc_gateway_runtime_digest() {
    local result
    result=$(sha256sum < "$1") || return 1
    printf '%s\n' "${result%% *}"
}

cc_gateway_managed_runtime() (
    set -euo pipefail
    set +x
    umask 077
    local kind=$1 arch=$2 base=$3 version archive_name archive_root url expected binary_relative
    case $kind in
        bun) version=1.4.0 ;;
        node) version=24.21.0 ;;
        *) cc_gateway_runtime_error 'Unknown runtime.'; exit 1 ;;
    esac
    case "$kind:$arch" in
        bun:x64)
            archive_name=bun-linux-x64-baseline.zip
            expected=184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f
            ;;
        bun:arm64)
            archive_name=bun-linux-aarch64.zip
            expected=4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e
            ;;
        node:x64)
            archive_name=node-v${version}-linux-x64.tar.xz
            expected=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
            ;;
        node:arm64)
            archive_name=node-v${version}-linux-arm64.tar.xz
            expected=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
            ;;
        *) cc_gateway_runtime_error 'Supported runtime architectures are x86_64 and aarch64.'; exit 1 ;;
    esac
    if [[ $kind == bun ]]; then
        archive_root=${archive_name%.zip}
        binary_relative=$archive_root/bun
        url=https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archive_name}
    else
        archive_root=${archive_name%.tar.xz}
        binary_relative=$archive_root/bin/node
        url=https://nodejs.org/dist/v${version}/${archive_name}
    fi

    cc_gateway_require_tools mkdir stat sha256sum || exit 1
    if [[ ! -e $base && ! -L $base ]]; then
        mkdir -p -- "$base" || exit 1
    fi
    if [[ ! -d $base ]] || ! cc_gateway_private_owned_path "$base"; then
        cc_gateway_runtime_error 'The runtime directory must be owned by you, writable only by you, and not a symlink.'
        exit 1
    fi

    local target=$base/$kind-$version-linux-$arch binary marker archive_digest binary_digest actual_version
    binary=$target/bin/$kind
    if [[ -e $target || -L $target ]]; then
        for marker in "$target" "$target/bin" "$binary" "$target/.owner" "$target/archive.sha256" "$target/binary.sha256"; do
            if ! cc_gateway_private_owned_path "$marker"; then
                cc_gateway_runtime_error 'Existing managed runtime has unsafe ownership or permissions; it was left unchanged.'
                exit 1
            fi
        done
        if [[ ! -d $target || ! -d $target/bin || ! -f $binary || ! -x $binary || ! -f $target/.owner || ! -f $target/archive.sha256 || ! -f $target/binary.sha256 ]]; then
            cc_gateway_runtime_error 'Existing runtime is not a recognized managed installation; it was left unchanged.'
            exit 1
        fi
        if ! IFS= read -r marker < "$target/.owner" ||
            ! IFS= read -r archive_digest < "$target/archive.sha256" ||
            ! IFS= read -r binary_digest < "$target/binary.sha256"; then
            cc_gateway_runtime_error 'Managed runtime receipts are incomplete; it was left unchanged.'
            exit 1
        fi
        if [[ $marker != cc-gateway-runtime-v1 || $archive_digest != "$expected" || ! $binary_digest =~ ^[0-9a-f]{64}$ ]] ||
            [[ $(cc_gateway_runtime_digest "$binary") != "$binary_digest" ]]; then
            cc_gateway_runtime_error 'Managed runtime verification failed; it was left unchanged.'
            exit 1
        fi
        actual_version=$("$binary" --version 2>/dev/null) || {
            cc_gateway_runtime_error 'Managed runtime cannot execute on this system.'
            exit 1
        }
        if [[ ${actual_version#v} != "$version" ]]; then
            cc_gateway_runtime_error 'Managed runtime version does not match its pin; it was left unchanged.'
            exit 1
        fi
        printf '%s\n' "$binary"
        exit 0
    fi

    cc_gateway_require_tools curl mktemp chmod cp mv rm || exit 1
    if [[ $kind == bun ]]; then
        cc_gateway_require_tools unzip || exit 1
    else
        cc_gateway_require_tools tar xz || exit 1
    fi
    local download='' extraction='' staging=''
    trap '[[ -z $download ]] || rm -rf -- "$download"; [[ -z $extraction ]] || rm -rf -- "$extraction"; [[ -z $staging ]] || rm -rf -- "$staging"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    download=$(mktemp -d "$base/.download.XXXXXXXX") || exit 1
    extraction=$(mktemp -d "$base/.extract.XXXXXXXX") || exit 1
    staging=$(mktemp -d "$base/.stage.XXXXXXXX") || exit 1
    printf 'Downloading pinned %s %s for Linux %s...\n' "$kind" "$version" "$arch" >&2
    curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 300 --output "$download/$archive_name" "$url" || exit 1
    if [[ $(cc_gateway_runtime_digest "$download/$archive_name") != "$expected" ]]; then
        cc_gateway_runtime_error 'Runtime archive SHA-256 verification failed.'
        exit 1
    fi
    if [[ $kind == bun ]]; then
        unzip -q "$download/$archive_name" "$binary_relative" -d "$extraction" || exit 1
    else
        tar --extract --xz --file "$download/$archive_name" --directory "$extraction" \
            --no-same-owner --no-same-permissions -- "$binary_relative" || exit 1
    fi
    if [[ ! -f $extraction/$binary_relative || -L $extraction/$binary_relative ]]; then
        cc_gateway_runtime_error 'Runtime archive does not contain the expected regular executable.'
        exit 1
    fi
    mkdir -- "$staging/bin" || exit 1
    cp -- "$extraction/$binary_relative" "$staging/bin/$kind" || exit 1
    chmod 700 -- "$staging/bin/$kind" || exit 1
    actual_version=$("$staging/bin/$kind" --version 2>/dev/null) || {
        cc_gateway_runtime_error 'Pinned runtime cannot execute on this system.'
        exit 1
    }
    if [[ ${actual_version#v} != "$version" ]]; then
        cc_gateway_runtime_error 'Downloaded runtime version does not match its pin.'
        exit 1
    fi
    printf '%s\n' cc-gateway-runtime-v1 > "$staging/.owner" || exit 1
    printf '%s\n' "$expected" > "$staging/archive.sha256" || exit 1
    cc_gateway_runtime_digest "$staging/bin/$kind" > "$staging/binary.sha256" || exit 1
    mv -T --no-clobber -- "$staging" "$target" || exit 1
    if [[ -d $staging ]]; then
        cc_gateway_runtime_error 'Runtime destination appeared during installation; it was left unchanged. Retry installation.'
        exit 1
    fi
    staging=''
    printf '%s\n' "$binary"
)

cc_gateway_select_runtime() {
    local kind=$1 arch=$2 base=$3 candidate version
    candidate=$(type -P "$kind") || candidate=''
    if [[ -n $candidate ]]; then
        candidate=$(realpath -- "$candidate") || return 1
        case $candidate in
            "$base"/*) ;;
            *)
                if version=$("$candidate" --version 2>/dev/null) && cc_gateway_runtime_version_ok "$kind" "$version"; then
                    printf '%s\n' "$candidate"
                    return 0
                fi
                ;;
        esac
    fi
    cc_gateway_managed_runtime "$kind" "$arch" "$base"
}

cc_gateway_bootstrap_runtime() {
    local arch base
    cc_gateway_require_tools uname realpath || return 1
    case $(uname -m) in
        x86_64|amd64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) cc_gateway_runtime_error 'Supported runtime architectures are x86_64 and aarch64.'; return 1 ;;
    esac
    base=${XDG_DATA_HOME:-$HOME/.local/share}/cc-gateway/runtime
    [[ $base == /* ]] || { cc_gateway_runtime_error 'HOME and XDG_DATA_HOME must resolve to absolute paths.'; return 1; }
    base=$(realpath -m -s -- "$base") || return 1
    [[ ! -L $base ]] || { cc_gateway_runtime_error 'The runtime directory must not be a symlink.'; return 1; }
    base=$(realpath -m -- "$base") || return 1
    CC_GATEWAY_BUN=$(cc_gateway_select_runtime bun "$arch" "$base") || return 1
    CC_GATEWAY_NODE=$(cc_gateway_select_runtime node "$arch" "$base") || return 1
}
