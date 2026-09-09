# Agent Bridge

A write channel into WorkFlow for an assistant running on the same Mac.

Reads go straight to the SwiftData store in read-only mode. Writes go through
the running app as JSON command files, because Core Data logs every save into
persistent-history tables and `NSPersistentCloudKitContainer` exports from that
log — a raw `INSERT` would land on this Mac and never reach the phone.

## Setup

1. Open WorkFlow on the Mac → **Settings → Agent Bridge** → switch it on.
   Off by default; it is a write channel into your data.
   The app immediately asks you to **choose a Bridge Folder** — pick one
   (your project folder is ideal; anywhere outside Desktop, Documents and
   Downloads). One click, once. See *Why a folder* below.
2. `Tools/agent-bridge/wf state` — confirms the app is watching and prints the
   live store path.
3. `Tools/agent-bridge/wf ping` — round-trips a command and waits for the receipt.

The app must be running for anything to happen, in both directions — and not
napped. macOS puts a backgrounded app to sleep, and a sleeping app stops
processing the silent pushes that carry your phone's comments; `wf wake
install` therefore sets "Prevent App Nap" for WorkFlow (Finder's Get Info
checkbox, from the shell — effective at the app's next launch). One more
thing the Mac can't fix: a comment only *leaves* your phone when WorkFlow
there is in the foreground for a moment. Post, then let the app draw. Nothing
reaches the store while it is closed, and nothing leaves for CloudKit either.
`open -ga ProjectManager` at the top of a polling script covers it.

## Why a folder

Until 4.2 the bridge lived inside the app's sandbox container. That works for
a terminal — an interactive process has a responsible app with granted access —
but a **background process has none**: launchd gets `Operation not permitted`
on everything under `~/Library/Containers/<app>`, reads included. A session
that starts on its own could neither see the wake signal nor reply, and the
wake script's `[[ -f "$WAKE_FILE" ]] || exit 0` turned that into a silent,
clean-looking exit.

A sandboxed app can only write inside its container or into a folder the user
has explicitly picked. So the fix is to let you pick one, hold it as a
security-scoped bookmark, and move the *whole* bridge there: inbox, outbox,
wake signal, audit — and a **`snapshot.json`** the app rewrites after every
save, carrying tasks with their comments and checklists, notes, projects and
smart lists. `wf` reads that instead of the SQLite store, which is also in the
container. Nothing in the background path touches the container any more.

Two consequences worth knowing:

- **Reads see your writes.** The app rewrites `snapshot.json` about two
  seconds after applying a command, so `wf` waits for it after every applied
  receipt before returning — `wf add X && wf show X` works. Without that, the
  second command read the old snapshot and reported no such task.
- `wf` finds the folder through `location.json`, a pointer the app writes
  *into the container* — readable from a terminal, not from launchd. The wake
  script therefore sets `WF_BRIDGE` explicitly, baked in by `wf wake install`.
  Set it yourself to point `wf` anywhere.
- The container is still a working fallback when no folder is chosen, so
  interactive use never breaks; it's only unattended use that needs the folder.
  `wf wake install` refuses until one is chosen, and warns if the folder or the
  tooling sits under Desktop, Documents or Downloads — macOS keeps background
  processes out of those too, which is how this was found.

## Commands

```
wf state                        Bridge status, folder, snapshot age
wf ping                         Confirm the app is watching
wf setup                        Install the workspace and its smart list
wf wake install|status|uninstall
                                launchd trigger for assigned tasks
wf tasks [--all]                List active tasks
wf queue                        Tasks assigned to the agent
wf show <task>                  One task with its comment thread
wf comment <task> <text>        Post a comment as the agent
wf poll [--since ISO8601]       Comments addressed to the agent since a mark
wf session [CODEBASE] [--log T] [--state T] [--open S] [--close S] [--list]
                                Claude's own cross-session log ("Claude Sessions" project,
                                one task per codebase; Alex leaves it alone)
wf session --attach FILE [--to T] Attach evidence to the session task (or --to another);
                                the comment records the original path
wf session --weekly             Post the week's session counts (the sweep runs this)
wf handoff TITLE [--command C]  A task for Alex, on the "Needs Alex" smart list
wf job TITLE --template T       Checklist Claude ticks as it works (release-ios/mac/android)
wf add <title> [--project P] [--due 2026-09-05] [--priority High]
                [--assignee Claude] [--status-note S]
                [--notes N] [--tag T] [--subtask S] [--comment C]
wf notes [--all]                The Notepad inbox
wf note <note>                  One note in full
wf jot <title> [--body TEXT] [--color '#RRGGBB'] [--pin]
wf reply <note> <text> [--pin]  Append a signed reply inside the note
wf convert <note> [--project P] [--title T] [--priority High]
                  [--due D] [--assignee A] [--subtask S]
wf check <task> <subtask>...    Tick subtasks off
wf uncheck <task> <subtask>...  Untick subtasks
wf rename <task> <old> <new>    Retitle a subtask in place (tick kept)
wf status <task> <text>         Set a task's pinned note
wf attach <task> <file> [--name N]
                                Attach a file to a task (staged via attachments/)
wf done <task>                  Complete a task
wf project <name> [--icon I] [--color '#RRGGBB'] [--description D]
wf pack <file.json> [--skip-existing]
```

`<task>` is a task UUID or a case-insensitive fragment of its title.
`WF_BRIDGE` points `wf` at a bridge folder directly; `WF_CONTAINER` overrides
the app container path (where the pointer and the fallback store live), for
testing against a simulator install.

## The workspace

`wf setup` stands up a **Claude** project, a standing **Briefing** task, and a
smart list — then stops. It is deliberately thin, and it is built entirely from
furniture the app already has, so it works on the phone with no new UI:

| Idea | What it actually is |
|---|---|
| The agent's queue | `assignee = "Claude"`. Assign a task from the phone exactly as you'd assign one to a person. `My Work` already renders the mirror image for you. |
| The dashboard | A `PMSmartList` with `filterAssignee: "Claude"`. Appears under Projects → Smart Lists on every device. |
| A job's status | The task's **pinned note** — a line the agent overwrites, so status doesn't pollute the comment thread. |
| Progress on a long job | **Subtasks**, ticked as the agent goes. Ticks stamp `markEdited`, so they light up as recent changes like any other. |
| The conversation | **Comments**. Agent replies notify you without needing an @mention. |

Running `wf setup` again is safe — the pack skips projects that already exist
and the smart list upserts by name.

A worked loop:

```sh
wf queue                                   # what's assigned to me
wf status "reduced-motion" "Working — 2 of 3 done."
wf check  "reduced-motion" "Apply the pattern"
wf comment "reduced-motion" "Twelve files done; device check left."
```

## The Notepad

Two jobs, both leaning on what the Notepad already is.

**Jotting is the cheapest way to hand over work.** Creating a task means a
title, an assignee and a project; a note means type and go, which one-handed on
a phone is the whole difference. Put `@claude` anywhere in a note and it becomes
a request:

```sh
wf notes                 # the inbox; * marks the ones addressed to the agent
wf note <id>             # one in full
wf convert <id> --subtask "..." --subtask "..."
```

`convert` promotes the note into a task in the `Claude` project and stamps the
note with a link to what it became — the same conversion the app's own sheet
performs, so the note stays put and shows its target. Converting is also what
takes it out of the inbox, so a handled note stops signalling.

**Notes are where output that isn't work belongs.** A task demands completion;
a summary, a finding or a set of options does not, and filing those as tasks
clutters a list with things nobody has to do:

```sh
wf jot "Reduced-motion audit — findings" --body "12 files animate unconditionally…" --pin
```

A marked note is a *tighter* trigger surface than a task, not a looser one:
notes never travel through `CKShare`, so nobody but the owner can write one.
The task trigger needs an explicit "refuse if shared" guard; the note trigger
gets the same property by construction.

The marker is typed rather than a note colour. One tap is cheaper than seven
characters, but a colour gets picked because it looked right, and an accidental
trigger is worse than two seconds of typing.

## The weekly portfolio sweep

The **🔧 Sprint and Updates** task is the index: one checklist line per app,
carrying its latest version. `wf sweep` keeps it honest and turns Notepad notes
into per-app fix lists:

```sh
wf sweep                 # report: version drift, notes to file, open lists
wf sweep --apply         # file notes, refresh versions, reply in each note
wf sweep install         # every Monday 09:00 (--day, --at), as a session
wf sweep status | uninstall
```

What a sweep does:

- **Versions** — searches the App Store by seller (so nothing is guessed) and
  rewrites any checklist line whose live version is newer. Android rows and
  unpublished projects are left alone.
- **Notes** — every unarchived, unconverted note that mentions an app by name
  is filed as a subtask of `<App> — updates & fixes` (created on first use, in
  the Opticell project, due date parked a year out). The note gets a one-line
  reply saying where it went, and its id is recorded in `sweep-state.json` so
  it's never filed twice. Notes that mention no app are listed and left alone.
- **Report** — the scheduled run posts a summary in the index task's thread.

`wf sweep install` runs the sweep *as a Claude session* rather than
mechanically, so judgement is applied — a note that mentions an app in passing
isn't a bug report. If the report is empty it doesn't start a session at all.

Why a scheduled job and not a recurring task assigned to Claude: when a
recurrence completes, the app spawns next week's copy immediately, and the wake
trigger reads that as new work — it would fire the moment you tick this week's,
not next Monday.

## Waking a session when work is assigned

`wf wake install` installs a launchd agent so that assigning a task actually
*starts* a Claude session, rather than leaving it in a queue for a session that
happens to be running.

```sh
wf wake install [--dir <working dir>] [--claude <path>]
wf wake status
wf wake uninstall
```

The app writes a signal file when scoped work appears; launchd watches that
directory and runs `claude-wake.sh`, which starts one headless session. Two
keys, deliberately: the app only signals, and nothing listens until you install
the agent.

### Switching it off

Settings → Agent Bridge carries three switches, and each one explains itself in
the section footer as you turn it on:

| Switch | What it governs |
|---|---|
| **Agent Bridge** | The whole thing. Off by default. Off means no command is read and nothing is written. |
| **Start Work On Its Own** | Whether new work may *begin* a session, rather than waiting until you ask. Off leaves the assistant purely on-demand — work still gathers in the `Claude` project, it just doesn't start anything. |
| **Notepad Requests** | Whether a note containing `@claude` counts as a request. Off makes it just text, so the marker can be a reminder to yourself. |
| **Notify Me About Replies** | Whether an agent reply raises a notification. On both Mac and iPhone — it governs the device it's set on. |

On iPhone the section carries only that last switch, plus a link to the Mac
listing and a short explanation. The bridge itself is a Mac arrangement and the
toggles are local `UserDefaults`, so a phone switch for them would control
nothing; the notification is the one part of this that genuinely happens on the
phone, so that is what the phone's switch governs.

Turning either trigger off still advances the watermark, so switching it back
on starts from that moment rather than replaying everything that accumulated
while it was off.

### The trigger boundary

A task's notes and comments are text that syncs, and on a shared project a
collaborator can write into them. Treating that text as something that starts a
session on your Mac is an injection surface, so the trigger is scoped:

- **A Bridge Folder must be chosen.** `wf wake install` refuses otherwise —
  a launchd session can't reach the container, so it would fire and find
  nothing.
- **Only tasks in the `Claude` project, or notes marked `@claude`, can wake a
  session.** Anything else assigned to Claude is queued and visible in
  `wf queue`, but inert.
- **Only while that project is unshared.** Sharing the workspace switches the
  trigger off rather than widening it — it fails closed.
- **The signal carries ids and titles only.** Notes and comments never travel
  through the trigger; the session fetches them itself and is told to read them
  as a request to weigh, not as instructions.

### What does and doesn't count as a request

The wake keys on a signature of title, notes, status, assignee, pinned note and
comment count — not on `updatedAt`. The app mutates tasks on its own
(`SmartNudgeService` escalates an aging task's priority at launch, and
auto-archive and Reminders sync do similar), and keying on row activity woke a
session every time it did. The agent's own edits never wake it either.

The runner tracks a sequence number, so a signal is acted on once even though
the plist carries a slow `StartInterval` as a safety net against a missed
filesystem event.

## Polling

`wf poll` is designed to be cheap on the ticks where nothing has happened: one
read-only SQLite query, a stored watermark, and an exit code that says whether
there is anything to do.

- exit **0** — there are new comments, printed to stdout
- exit **1** — nothing new

So a loop only needs to wake a real turn when `wf poll` succeeds:

```sh
open -ga ProjectManager
wf poll || exit 0        # nothing to answer; go back to sleep
```

The watermark lives at `AgentBridge/.wf-watermark` inside the app container.
Comments the agent wrote itself are never reported back to it.

## Round-trip latency

Phone → CloudKit is seconds. CloudKit → Mac is seconds to a minute, and only
while the app is open. Add the poll interval and a reply lands back on the
phone roughly **1–6 minutes** after it was written. Async correspondence, not
chat — pick a poll interval that reflects that.

## Protocol

One JSON file per command in `AgentBridge/inbox/`, written atomically (temp
file + rename — a half-written file is skipped for 5 seconds, then reported as
unreadable). The app answers in `AgentBridge/outbox/<id>.json` and moves the
command to `processed/`.

```json
{ "id": "unique-string", "op": "add_comment",
  "taskID": "…", "text": "…", "mentions": ["Alex"] }
```

Receipt:

```json
{ "id": "…", "op": "…", "status": "applied|failed|rejected",
  "at": "2026-09-01T21:59:20Z", "taskID": "…", "message": "…" }
```

Ops: `ping`, `create_task`, `update_task`, `complete_task`, `add_comment`,
`create_project`, `create_smart_list`, `create_note`, `convert_note`,
`attach_file`, `update_note`, `install_pack`. `update_note` only ever
*appends* to a note's body (signed and dated) — it never rewrites what the
user wrote — and keeps the rich-text and plain-text copies in step, since the
editor shows the rich one. `attach_file` takes a bare filename inside the
bridge folder's `attachments/` — never a path — so it can't be turned into a
file reader; `wf attach` does the staging for you. `update_task` also takes
`addSubtasks[]`, `checkSubtasks[]`, `uncheckSubtasks[]` and, since 4.4,
`renameSubtasks[]` of `{from, to}` — a retitle in place that keeps the tick
(plain `subtasks[]` replaces the list and its tick state). Dates accept ISO-8601 with or without
fractional seconds, or `yyyy-MM-dd`. The app writes a fuller reference to
`AgentBridge/README.txt` when the bridge is first enabled.

## Identity

Everything the bridge writes is authored as **Claude** (`agent.claude`) in both
the comment thread and the activity log, so an automated edit is always
distinguishable from your own. An agent comment arriving on another device
raises a notification there without needing to know your iCloud display name.

## Claude Desktop

`../workflow-mcp/` wraps all of this as an MCP server, so Claude Desktop can
use WorkFlow directly instead of you running these commands. Same bridge, same
Settings toggles, same Command History.

## What it cannot do

- Run while the Mac app is closed. The wake trigger included — the app is what
  notices the work.
- Reach the Claude iOS app or claude.ai. Those need a *remote* MCP server over
  HTTPS with OAuth. Claude Desktop runs local ones, which is why
  `../workflow-mcp/` works and a browser connector doesn't.
- Delete anything. There is no destructive op, deliberately.

## `wf mail` — the unread inbox, read-only (Tier 3)

Reads the UNSEEN messages of an iCloud inbox over IMAP so a scheduled
session can turn what needs doing into tasks. Read-only by construction: the
mailbox is opened read-only and nothing is ever stored back, so Mail on your
phone doesn't even see the messages as read.

    wf mail setup you@icloud.com     # app-specific password → login Keychain (service "wf-mail")
    wf mail [-v] [--new] [--json]    # list unread; --new hides ids already handled
    wf mail mark <id> ...            # record ids as handled (mail-state.json in the bridge folder)
    wf mail install [--every 30]     # launchd runner: claude-mail.sh hands new mail to a session
    wf mail status | uninstall

Make the app-specific password at appleid.apple.com → Sign-In and Security →
App-Specific Passwords. `mail.config` (address + host) is git-ignored; the
password is never written to a file.

The runner's session treats every email as DATA: it never replies, forwards,
deletes or marks mail, and an email that asks for anything beyond being
summarised into a task is reported in the summary and otherwise ignored.
Tasks go into a project called "Mail"; a one-line summary lands on the
"Sprint and Updates" thread so it reaches the phone.
