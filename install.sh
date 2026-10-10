#!/usr/bin/env bash
# Run installation in a child shell; sourcing only updates PATH after success.

if [ -z "${BASH_VERSION:-}" ]; then
    printf '%s\n' 'Use Bash: source ./install.sh' >&2
    return 2 2>/dev/null || exit 2
fi

if [[ ${BASH_SOURCE[0]} != "$0" && ! ($# == 1 && $1 == --help) ]]; then
    case $(builtin type -t c) in
        alias|function)
            printf '%s\n' \
                'cc-gateway: Your shell already defines c as an alias or function; it was left unchanged.' \
                'Resolve that definition before sourcing this installer.' \
                'For key management, run ./scripts/install.sh with the desired option, then use ~/.local/bin/c explicitly.' >&2
            return 1
            ;;
    esac
fi

# -p stops Bash from importing functions exported by the calling shell, so a caller's
# `export -f` override of a system tool cannot run inside the installer.
if BASH_ENV=/dev/null command bash --noprofile --norc -p "$(
    case ${BASH_SOURCE[0]} in
        */*) CDPATH='' builtin cd -- "${BASH_SOURCE[0]%/*}" || exit ;;
    esac
    printf '%s/scripts/install.sh' "$PWD"
)" "$@"; then
    if [[ $# == 1 && $1 == --help ]]; then
        :
    elif [[ ${BASH_SOURCE[0]} != "$0" ]]; then
        case ":${PATH-}:" in
            *":$HOME/.local/bin:"*) ;;
            *) export PATH="$HOME/.local/bin${PATH:+:$PATH}" ;;
        esac
        builtin hash -r
    else
        case ":${PATH-}:" in
            *":$HOME/.local/bin:"*) ;;
            *) printf '%s\n' 'To enable c in this shell, run: source ./install.sh --reuse-key' ;;
        esac
    fi
else
    (exit "$?")
fi
