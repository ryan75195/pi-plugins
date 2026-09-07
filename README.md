# pi-plugins

Extensions and plugins for AI coding agents — [pi](https://pi.dev) extensions and [opencode](https://opencode.ai) plugins.

## Install (pi)

```bash
# Everything (all extensions in this repo)
pi install git:github.com/ryan75195/pi-plugins

# Or just symlink one extension
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-plugins/extensions/background-tasks ~/.pi/agent/extensions/background-tasks
```

## Install (opencode)

```bash
npm run install:opencode
```

Copies every plugin in `opencode/plugins/` and every command in
`opencode/commands/` into `~/.config/opencode/`. They are copies, so re-run it
after each merge and restart running opencode instances.

## Extensions

| Extension | Targets | Description |
|-----------|---------|-------------|
| [background-tasks](extensions/background-tasks/) / [opencode](opencode/) | pi, opencode | Claude Code-style background shell tasks: run commands without blocking, task IDs, output files, completion notifications. pi gets a live task panel + interactive `/tasks` manager; opencode gets session notifications + toasts. |

## Development

```bash
npm install
npm run typecheck   # typechecks pi + opencode extensions
```

## Security

Extensions run with full system access and can execute arbitrary code. Review the source before installing.
