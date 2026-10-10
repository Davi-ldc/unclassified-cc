#!/usr/bin/env bash
# Install the gateway in an isolated shell. The TypeScript helper owns all
# persistent configuration, credentials, launcher and service changes.

cc_gateway_install_usage() {
    printf '%s\n' \
        'Usage: source ./install.sh [--reuse-key | --api-key-stdin]' \
        '       source ./install.sh --add-key [--api-key-stdin]' \
        '       source ./install.sh --list-keys' \
        '       source ./install.sh --remove-key N' \
        '       ./install.sh --help' \
        '' \
        'The default prompts for an API key without displaying it.' \
        'An exported CC_GATEWAY_UPSTREAM_API_KEY supplies a new key without a prompt.' \
        '--reuse-key      Keep the existing managed key without prompting.' \
        '--api-key-stdin  Read a plaintext key from stdin; an empty value reuses the managed key.' \
        '--add-key        Add a fallback key; requires a new, nonempty key.' \
        '--list-keys      Show key indexes and roles, without key values.' \
        '--remove-key N   Remove the key at the listed index; the last key cannot be removed.' \
        '' \
        'Requires Linux (including WSL with systemd), a working user systemd manager,' \
        'and the official claude command already installed. No login or model call is made.'
}

cc_gateway_clean_environment() {
    local name
    while IFS= read -r name; do
        case $name in
            HOME|PATH|USER|LOGNAME|SHELL|LANG|LC_ALL|LC_CTYPE|LC_MESSAGES|LC_COLLATE|LC_NUMERIC|LC_TIME|LC_MONETARY|TERM|TMPDIR|XDG_DATA_HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)
                ;;
            *) export -n "$name" ;;
        esac
    done < <(compgen -e)
}

cc_gateway_install_main() (
    set +x
    set -euo pipefail
    set +a
    umask 077
    local supplied_key mode=prompt action=apply index='' root key_state tty_fd
    export -n supplied_key
    supplied_key=${CC_GATEWAY_UPSTREAM_API_KEY-}
    unset CC_GATEWAY_UPSTREAM_API_KEY
    cc_gateway_clean_environment

    if [[ $# == 1 && $1 == --help ]]; then
        cc_gateway_install_usage
        exit 0
    fi
    while (( $# > 0 )); do
        case $1 in
            --reuse-key|--api-key-stdin)
                if [[ $mode != prompt ]]; then
                    printf '%s\n' 'cc-gateway: Choose one key input option. Use --help for usage.' >&2
                    exit 2
                fi
                if [[ $1 == --reuse-key ]]; then mode=reuse; else mode=stdin; fi
                supplied_key=''
                ;;
            --add-key|--list-keys|--remove-key)
                if [[ $action != apply ]]; then
                    printf '%s\n' 'cc-gateway: Choose one key management action. Use --help for usage.' >&2
                    exit 2
                fi
                action=${1#--}
                if [[ $action == remove-key ]]; then
                    if (( $# < 2 )) || [[ ! $2 =~ ^[1-9][0-9]*$ ]]; then
                        printf '%s\n' 'cc-gateway: --remove-key needs a positive key index from --list-keys.' >&2
                        exit 2
                    fi
                    index=$2
                    shift
                fi
                ;;
            *) printf '%s\n' 'cc-gateway: Unsupported option. Use --help for usage; never pass an API key as an argument.' >&2; exit 2 ;;
        esac
        shift
    done
    if [[ ($action == add-key && $mode == reuse) || (($action == list-keys || $action == remove-key) && $mode != prompt) ]]; then
        printf '%s\n' 'cc-gateway: This key input option cannot be combined with the selected action. Use --help for usage.' >&2
        exit 2
    fi

    if [[ -z ${HOME:-} || $HOME != /* ]]; then
        printf '%s\n' 'cc-gateway: HOME must be an absolute path.' >&2
        exit 1
    fi
    root=$(CDPATH='' builtin cd -- "$(command dirname -- "${BASH_SOURCE[0]}")/.." && builtin pwd -P) || exit 1
    source "$root/scripts/bootstrap-runtime.sh" || exit 1
    cc_gateway_require_tools uname systemctl realpath || exit 1
    if [[ $(uname -s) != Linux ]]; then
        cc_gateway_runtime_error 'Installation requires Linux or WSL with systemd enabled.'
        exit 1
    fi
    if ! type -P claude >/dev/null; then
        cc_gateway_runtime_error 'Install the official Claude Code CLI first, then retry. This installer does not install it or sign you in.'
        exit 1
    fi
    if ! systemctl --user show-environment </dev/null >/dev/null 2>&1; then
        cc_gateway_runtime_error 'Cannot reach your systemd user manager. On WSL, enable systemd and restart WSL before retrying.'
        exit 1
    fi

    cc_gateway_bootstrap_runtime </dev/null || exit 1
    export PATH="${CC_GATEWAY_NODE%/*}:${CC_GATEWAY_BUN%/*}:$PATH"
    builtin cd -- "$root" || exit 1
    printf '%s\n' 'Installing locked dependencies and building cc-gateway...'
    "$CC_GATEWAY_BUN" --no-env-file install --frozen-lockfile --ignore-scripts </dev/null || exit "$?"
    "$CC_GATEWAY_BUN" --no-env-file run build </dev/null || exit "$?"
    case $action in
        list-keys)
            supplied_key=''
            "$CC_GATEWAY_BUN" --no-env-file "$root/src/scripts/install.ts" list-keys --root "$root" --node "$CC_GATEWAY_NODE" </dev/null || exit "$?"
            exit 0
            ;;
        remove-key)
            supplied_key=''
            "$CC_GATEWAY_BUN" --no-env-file "$root/src/scripts/install.ts" remove-key --root "$root" --node "$CC_GATEWAY_NODE" --index "$index" </dev/null || exit "$?"
            exit 0
            ;;
    esac
    key_state=$("$CC_GATEWAY_BUN" --no-env-file "$root/src/scripts/install.ts" preflight --root "$root" --node "$CC_GATEWAY_NODE" </dev/null) || exit "$?"
    case $key_state in
        key-present|key-required) ;;
        *) cc_gateway_runtime_error 'Installer preflight returned an unexpected result.'; exit 1 ;;
    esac

    case $mode in
        reuse)
            if [[ $key_state != key-present ]]; then
                cc_gateway_runtime_error 'There is no valid managed API key to reuse. Run source ./install.sh to supply one.'
                exit 1
            fi
            ;;
        stdin)
            # Bound input and reject NUL before handing plaintext to the helper.
            if IFS= read -r -d '' -n 16385 supplied_key; then
                cc_gateway_runtime_error 'API key input contains a NUL byte or exceeds 16 KiB.'
                exit 1
            fi
            ;;
        prompt)
            if [[ -z $supplied_key ]]; then
                if [[ ! -t 0 ]] || ! { exec {tty_fd}<> /dev/tty; } 2>/dev/null; then
                    cc_gateway_runtime_error 'No terminal is available. Use --reuse-key, --api-key-stdin, or CC_GATEWAY_UPSTREAM_API_KEY.'
                    exit 1
                fi
                if [[ $action == apply && $key_state == key-present ]]; then
                    printf '%s' 'Upstream API key (leave blank to reuse): ' >&"$tty_fd"
                else
                    printf '%s' 'Upstream API key: ' >&"$tty_fd"
                fi
                if ! IFS= read -r -s -u "$tty_fd" supplied_key; then
                    printf '\n' >&"$tty_fd"
                    cc_gateway_runtime_error 'API key input was cancelled.'
                    exit 1
                fi
                printf '\n' >&"$tty_fd"
                exec {tty_fd}>&-
            fi
            ;;
    esac
    if [[ -z $supplied_key && ($key_state == key-required || $action == add-key) ]]; then
        cc_gateway_runtime_error 'This action needs a new API key.'
        exit 1
    fi

    printf '%s' "$supplied_key" |
        "$CC_GATEWAY_BUN" --no-env-file "$root/src/scripts/install.ts" "$action" --root "$root" --node "$CC_GATEWAY_NODE" || exit "$?"
    supplied_key=''
    printf '%s\n' \
        'cc-gateway is ready. Run: c' \
        'Service status: systemctl --user status cc-gateway.service' \
        'Service logs: journalctl --user -u cc-gateway.service -f' \
        'Stop service: systemctl --user stop cc-gateway.service'
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    cc_gateway_install_main "$@"
fi
