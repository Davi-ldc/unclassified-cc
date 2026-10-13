# unclassified-cc

A local gateway that lets you run CC with a neutral request profile to use the 200usd free api credits. 

## Quick start

```bash
git clone https://github.com/Davi-ldc/unclassified-cc.git
cd unclassified-cc
source ./install.sh
c
```

`source ./install.sh` builds the gateway, asks for your Anthropic API key (nothing is echoed), starts it as a user service and puts the `c` command on your PATH for the current shell. In terminals you open later `c` is usually already available, because many distributions add `~/.local/bin` to PATH at login once the folder exists. If yours does not, add `~/.local/bin` to PATH in your shell profile. The installer never edits your shell files.

## how 

The gateway forwards requests to `api.anthropic.com` after applying a fixed profile. It sets `User-Agent: opencode/1.18.35`, drops `x-app`, `anthropic-beta`, `x-claude-code-session-id` and every other client or session header, removes `metadata.user_id`, and rewrites the client's built-in prompts and tool definitions to neutral wording. Tool names, parameter names and schemas are translated on the way out and translated back on the way in, so file edits, shell commands, agents and skills keep working. Everything else is passed through unchanged, including your prompts, file contents, tool results, thinking blocks and the model and effort settings.

`c` uses its own profile directory, `~/.local/share/cc-gateway/claude`, so it does not share a login with your regular `claude` and never shows the "both claude.ai and ANTHROPIC_API_KEY are set" warnings. The first run is pre-approved for the gateway token, and Claude Code only asks once per folder whether you trust it. Settings, memory, plugins and history in your normal `~/.claude` are not visible to `c`, and nothing is copied or deleted. Use `/config` inside `c` to set it up the way you like.

## Several API keys and fallback

```bash
source ./install.sh --add-key      # prompts for another key, hidden
source ./install.sh --list-keys    # shows positions only, never key values
source ./install.sh --remove-key 2 # removes the key at position 2
```

These key-management commands work from another clone too. They update the existing installation without moving its service or `c` command.

## Everyday commands

```bash
systemctl --user status cc-gateway      # is the gateway running
journalctl --user -u cc-gateway -f      # logs, which never contain keys or prompts
git pull && source ./install.sh --reuse-key   # update and restart, keeping the stored key
source ./install.sh                     # replace the primary key (hidden prompt)
echo "$KEY" | ./scripts/install.sh --api-key-stdin   # non-interactive, key from stdin
```

To switch an existing installation to a new clone, run `source ./install.sh --reuse-key` there. The installer copies the existing configuration, keeps all API keys and the client token, and points the service and `c` at the new clone. The old files and Claude profile are left intact. A different configuration or unrecognized client launcher in the new clone is refused; if activation fails, the previous installation is restored.

## Uninstall

```bash
systemctl --user disable --now cc-gateway
rm -f ~/.config/systemd/user/cc-gateway.service ~/.local/bin/c
rm -rf ~/.config/cc-gateway ~/.local/share/cc-gateway
systemctl --user daemon-reload
```

Then delete the cloned folder.