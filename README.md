# WorkFlow Agent Bridge

Tooling that lets a coding agent on your Mac — Claude Code, Claude Desktop, or
anything that can run a command — read and write your **WorkFlow** tasks.

Assign a task to the agent on your phone; it picks the work up on the Mac,
comments back in the same thread, and the reply arrives as a notification.
Nothing here is a service: it is a CLI and an MCP server talking to the app
running on the same machine.

- **`agent-bridge/`** — `wf`, a single-file Python CLI, plus the launchd
  scripts that start a session when work arrives.
- **`workflow-mcp/`** — the same operations as MCP tools, for Claude Desktop
  (`server.py`, which reuses `wf`) and the standalone Node port (`index.js`)
  that the app itself ships.

WorkFlow for Mac: https://apps.apple.com/app/id6777460380

## How it works

**Reads** go straight to `snapshot.json` in the bridge folder — tasks with
their comments and checklists, notes, projects and smart lists — which the app
rewrites after every save.

**Writes** go through the running app as JSON command files. They are not
written into the database directly, and that is the whole design: Core Data
logs every save into persistent-history tables and `NSPersistentCloudKitContainer`
exports from that log, so a raw `INSERT` would land on this Mac and never reach
the phone. The app applies the command, syncs it, and drops a receipt.

Consequences worth knowing before you build on it:

- The app must be running, on both machines. Nothing moves while it is closed.
- Reads see your writes: `wf` waits for the snapshot to be rewritten after an
  applied command, so `wf add X` followed by `wf show X` behaves.
- The bridge lives in a folder **you** pick, not in the app's sandbox
  container, because a launchd process has no access to a container. See
  `agent-bridge/README.md` for the full story.

## Quick start

1. WorkFlow on the Mac -> Settings -> Agent Bridge -> switch it on, and pick a
   bridge folder when asked. It is off by default: it is a write channel into
   your own data.
2. `agent-bridge/wf state` — confirms the app is watching.
3. `agent-bridge/wf ping` — round-trips a command and waits for the receipt.
4. `agent-bridge/wf setup` — installs the "Claude" project, its two standing
   tasks and the smart list that shows the queue.

Then, on the phone: assign a task to Claude. On the Mac: `wf queue`.

`agent-bridge/README.md` documents every command; `workflow-mcp/README.md`
covers the Claude Desktop route.

## Design notes

- **No destructive command.** There is deliberately no delete. The agent can
  create, comment, tick and complete; it cannot remove your data.
- **Only one project can start a session.** The wake trigger fires for tasks
  in the agent's own project, and only while that project is unshared, so a
  shared task cannot make your Mac run an agent.
- **Every write is logged.** The app keeps a Command History you can read.
- **Credentials stay out of the repo.** The optional mail integration keeps its
  app-specific password in the login Keychain, never in a file; `wake.config`
  and `mail.config` are local and gitignored.

## Configuration

| Variable | Meaning |
|---|---|
| `WF_BRIDGE` | Path to the bridge folder. Otherwise `wf` finds it through the app's pointer file, then the container. |
| `WF_OWNER` | Whose desk `wf handoff` puts a task on. Defaults to the Mac account name. |
| `WF_OWNER_PROJECT` | Default project for those handoffs. |

## Requirements

macOS with WorkFlow installed and the Agent Bridge enabled. `wf` and
`server.py` run on the system Python 3 with no third-party packages;
`index.js` needs Node.

## Licence

MIT — see `LICENSE`.
