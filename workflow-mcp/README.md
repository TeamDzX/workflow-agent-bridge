# WorkFlow MCP server

Lets **Claude Desktop** drive WorkFlow. Works in Claude Code too, as an
alternative to running `wf` by hand.

This is the one route into WorkFlow from a Claude app that isn't blocked.
claude.ai in a browser and Claude on iPhone need a *remote* MCP server over
HTTPS with OAuth; Claude Desktop runs local ones, so this needs no tunnel, no
hosting and no OAuth.

## Setup

```sh
python3 server.py --print-config
```

It prints the block to paste into
`~/Library/Application Support/Claude/claude_desktop_config.json`, plus the
one-liner for Claude Code. Restart Claude Desktop afterwards.

Requires WorkFlow running on this Mac with **Settings → Agent Bridge** on.
Nothing moves while the app is closed, in either direction.

## What it exposes

| Tool | |
|---|---|
| `workflow_state` | Bridge status and which store is live. Start here if anything fails. |
| `workflow_list_tasks` | Tasks with status, priority, project, due date |
| `workflow_get_task` | One task in full, with its comment thread |
| `workflow_queue` | The agent's inbox — status line, checklist, latest comment |
| `workflow_poll_comments` | Comments left since the last check |
| `workflow_create_task` | Including tags, subtasks and an opening comment |
| `workflow_comment` | Reply in a task's thread — reaches the phone as a notification |
| `workflow_set_status_line` | The pinned "where this stands" line |
| `workflow_check_subtasks` | Tick progress off (or untick) |
| `workflow_complete_task` | |
| `workflow_create_project` | |
| `workflow_list_notes` / `workflow_get_note` | The Notepad inbox |
| `workflow_create_note` | File output that isn't work |
| `workflow_convert_note` | Promote a note into a task, keeping the link |

## How it's built

It does not reimplement the CLI. `server.py` loads `../agent-bridge/wf` as a
module and calls the same functions, so there is one implementation to keep
correct — reads go straight to the SwiftData store read-only, writes go through
the Agent Bridge and are applied by the app.

That means the same Settings toggles and the same Command History govern what
Claude Desktop does. One control surface, not two.

Two details worth knowing if you touch it:

- **stdout is the transport.** The CLI prints to stdout, so every call is run
  under `redirect_stdout` — anything that leaked would corrupt the protocol
  stream.
- **Exit codes are results, not failures.** `queue` and `poll` exit 1 for
  "nothing to do". Only exit 2 (the app refused a command) is reported to the
  model as an error.

No third-party packages; it runs on the system Python. The generated config
pins `/usr/bin/python3` rather than whatever interpreter happened to print it —
running this from a developer shell picks up Xcode's bundled Python, whose path
moves with an Xcode update.

## `index.js` — the server that ships with the app (4.4)

A standalone Node port of `server.py` with no dependency on `wf`. The app
bundles it and writes it into the bridge folder as `tools/index.js`, and
packs it into `WorkFlow.mcpb` when the user clicks **Install in Claude
Desktop** (Settings → Agent Bridge). Claude Desktop installs the bundle in one
click and runs it with its own Node runtime.

    node index.js --print-config          # config snippet + the Claude Code line
    WF_BRIDGE=/path/to/WorkFlowBridge node index.js   # what a client runs

Bridge lookup order: `$WF_BRIDGE`, the app's `location.json` pointer, the
app's container. `server.py` remains for anyone who prefers Python; the two
expose the same tools.
