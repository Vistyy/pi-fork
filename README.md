# pi-fork

Adds a `fork` tool for running focused work in a child Pi process.

A fork starts from a temporary snapshot of the current active session branch, runs the requested task, and returns a structured report.
Use it for noisy investigation, review, debugging, validation, or option analysis that would clutter the main conversation.

## Install locally

```bash
pi install /home/syzom/projects/pi-extensions/pi-fork
```

For one-off testing:

```bash
pi -e /home/syzom/projects/pi-extensions/pi-fork
```

## Install from GitHub

```bash
pi install git:github.com/Vistyy/pi-fork@v0.1.6
```

## Tool

```json
{
  "task": "Inspect the eval harness and report where fork evals should go.",
  "effort": "balanced"
}
```

`effort` is optional: `fast`, `balanced`, or `deep`.

## Child tools and extensions

Fork children inherit parent `--tools` / `--no-tools` behavior by default, unless `pi-fork.tools` is set.

```json
{
  "pi-fork": {
    "tools": "read,bash,grep,find,ls,web_search,web_fetch,web_content_get"
  }
}
```

`tools` is tri-state:

| value | behavior |
| --- | --- |
| omitted / `null` | inherit parent Pi `--tools` / `--no-tools` behavior |
| `""` | pass `--no-tools` |
| `"read,bash"` | pass `--tools read,bash` |

Tool names are comma-separated and normalized for whitespace. Malformed names are ignored.

Fork children load no extensions by default.

```json
{
  "pi-fork": {
    "extensions": []
  }
}
```

`extensions` is tri-state:

| value | behavior |
| --- | --- |
| omitted | no child extensions |
| `[]` | no child extensions |
| `null` | normal Pi extension discovery |
| `["<source>"]` | only listed extension sources |

Nested forks are not allowed.
Fork child processes do not register the `fork` tool, even if `pi-fork` is allowlisted as a child extension.

## Guarded exploratory fork children

A practical guarded setup removes file-writing tools and loads the sandbox hook:

```json
{
  "pi-fork": {
    "tools": "read,bash,grep,find,ls,web_search,web_fetch,web_content_get",
    "extensions": [
      "./extensions/web-search",
      "~/projects/pi-extensions/pi-fork/sandbox.ts"
    ]
  }
}
```

This is a workflow guardrail for exploratory fork work, not a security boundary for hostile repositories.

This does two things:

- `--tools` removes `edit` and `write` from the child process.
- `sandbox.ts` wraps `bash` with bwrap so the repo is mounted read-only, a per-fork temp dir is writable, inherited environment variables are cleared, and shell network follows `pi-fork.sandbox.bashNetwork`.

The sandbox hook must be present in `pi-fork.extensions`.
If a project overrides `pi-fork.extensions`, include `~/projects/pi-extensions/pi-fork/sandbox.ts` there too or the bash hook will not load.

Sandbox defaults:

```json
{
  "pi-fork": {
    "sandbox": {
      "bashNetwork": false,
      "tmpDir": "/tmp"
    }
  }
}
```

`bashNetwork: false` isolates sandboxed `bash` from the host network. Set it to `true` to add `bwrap --share-net`, for example when a fork needs `git clone` or package-manager fetches. This is separate from `offline`.

`tmpDir` controls the parent directory used to create a per-fork writable `TMPDIR` and must be under `/tmp` or `/var/tmp`.
Child prompts mention the generated per-fork directory so fork agents know where to put scratch files, downloads, clones, and quick experiments.
The same path is visible to sandboxed `bash` and host-mediated child tools such as `read`.

`web_search`, `web_fetch`, and `web_content_get` are host-mediated text tools. They still work with shell network disabled because they are not run inside sandboxed `bash`. They fetch/extract/store text; they do not execute page JavaScript or fetched scripts.

## Session snapshot

Forks receive a filtered copy of Pi's current model context window.
Before compaction, that means user messages and visible assistant text from the active context.
After compaction, that means Pi's compaction summary plus user messages and visible assistant text since the compaction boundary.

Fork snapshots strip tool calls, tool results, bash execution messages, assistant thinking blocks, custom messages, and branch summaries.
The parent session is not mutated.
The actual fork child still runs as a separate Pi process on the filtered temp session.

## Config

Config goes under `pi-fork` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

Precedence is: defaults < global `~/.pi/agent/settings.json` < project `.pi/settings.json`. Project settings can intentionally override fork tools, extensions, activation, sandbox options, and environment for that project.

```json
{
  "pi-fork": {
    "offline": true,
    "costFooter": true,
    "environment": {
      "MY_MODE": "fork"
    },
    "activation": {
      "command": "direnv",
      "args": ["exec", "{cwd}"]
    },
    "defaultEffort": "balanced",
    "effortProfiles": {
      "fast": {
        "provider": "openai-codex",
        "id": "gpt-5-mini",
        "thinking": "minimal"
      },
      "balanced": {
        "provider": "openai-codex",
        "id": "gpt-5.5",
        "thinking": "medium"
      },
      "deep": {
        "provider": "openai-codex",
        "id": "gpt-5.5",
        "thinking": "high"
      }
    }
  }
}
```

Defaults:

```text
extensions: []
tools: null
offline: true
sandbox.bashNetwork: false
sandbox.tmpDir: /tmp
costFooter: true
environment: {}
activation: null
```

`activation` wraps child Pi startup in a project environment activator.
Use `{cwd}` in activation arguments to insert the fork working directory.
For example, `{"command":"direnv","args":["exec","{cwd}"]}` launches child Pi as `direnv exec <cwd> pi ...` so forks see the same project shell as normal repo commands.
Project settings can set `activation` to `null` to disable a global activation wrapper.

`offline: true` sets `PI_OFFLINE=1` for children. This is Pi's internal offline mode; it skips version checks and tool binary downloads. It does not sandbox network access for `bash` or child extensions. Set `offline: false` when child extension sources need network install behavior.

Shell network access is controlled only by `sandbox.bashNetwork` when `~/projects/pi-extensions/pi-fork/sandbox.ts` is loaded.

`costFooter: true` shows aggregate fork cost in the footer, for example:

```text
forks +$0.123
```

## Good use cases

- broad code search
- independent review
- debugging traces
- validation runs
- architecture or option comparison
- docs/source inspection

Avoid forks for trivial edits, single-file reads, or questions the current agent can answer directly.
