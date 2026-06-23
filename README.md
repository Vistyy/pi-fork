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
pi install git:github.com/Vistyy/pi-fork@v0.1.0
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
- `sandbox.ts` wraps `bash` with bwrap so the repo is mounted read-only, the configured temp dir is writable, inherited environment variables are cleared, and shell network follows `pi-fork.sandbox.bashNetwork`.

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

`tmpDir` controls writable `TMPDIR` for sandboxed `bash` and must be under `/tmp` or `/var/tmp`. Child prompts mention this directory so fork agents know where to put scratch files, downloads, clones, and quick experiments.

`web_search`, `web_fetch`, and `web_content_get` are host-mediated text tools. They still work with shell network disabled because they are not run inside sandboxed `bash`. They fetch/extract/store text; they do not execute page JavaScript or fetched scripts.

## Session snapshot

Forks use the full active session branch by default.
Projects that also use observational memory can opt into OM-backed compact snapshots to reduce child input cost:

```json
{
  "pi-fork": {
    "sessionSnapshot": "om-compact",
    "omCompactExtension": "~/projects/pi-extensions/pi-observational-memory/index.ts"
  }
}
```

`om-compact` first copies the full parent session to the fork temp session.
It then starts a short-lived preflight worker process, loads only the configured `omCompactExtension`, runs Pi's native `session_before_compact` extension hook against that copy, and requires observational memory to return an `om.folded` compaction.
Other local/global extensions are not loaded during this preflight, so provider overrides and extension side effects stay out of the parent process.
The preflight worker exits after compaction, so large temporary session state is released before the parent continues.
The parent session is not mutated.
If `omCompactExtension` is unset, missing, or does not provide OM compaction, the fork fails instead of falling back to model-based native compaction.
The actual fork child still runs as a separate Pi process on the compacted temp session.

## Config

Config goes under `pi-fork` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

Precedence is: defaults < global `~/.pi/agent/settings.json` < project `.pi/settings.json`. Project settings can intentionally override fork tools, extensions, sandbox options, and environment for that project.

```json
{
  "pi-fork": {
    "offline": true,
    "costFooter": true,
    "environment": {
      "MY_MODE": "fork"
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
sessionSnapshot: full
omCompactExtension: unset
environment: {}
```

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
