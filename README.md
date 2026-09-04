# pi-plugins

A collection of [pi coding agent](https://pi.dev) extensions, skills, prompts and themes.

Everything here is a [pi package](https://pi.dev) — install the whole repo, or cherry-pick single extensions by path.

## Install

```bash
# Everything (all extensions in this repo)
pi install git:github.com/ryan75195/pi-plugins

# Or just symlink one extension
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-plugins/extensions/background-tasks ~/.pi/agent/extensions/background-tasks
```

## Extensions

| Extension | Description |
|-----------|-------------|
| [background-tasks](extensions/background-tasks/) | Claude Code-style background shell tasks: run commands without blocking, task IDs, output files, completion notifications, live task panel, interactive `/tasks` manager. |

## Security

Extensions run with full system access and can execute arbitrary code. Review the source before installing.
