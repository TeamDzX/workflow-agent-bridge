#!/usr/bin/env python3
"""WorkFlow MCP server — lets Claude Desktop (and Claude Code) drive WorkFlow.

Speaks MCP over stdio. Reads tasks and notes straight from the SwiftData store
in read-only mode; writes go through the Agent Bridge, so the app applies them
and the same Settings toggles and Command History govern what happens.

It does not reimplement any of that. It loads `Tools/agent-bridge/wf` as a
module and calls the same functions the command line does, so there is one
implementation to keep correct.

Setup:
    python3 server.py --print-config      # paste into Claude Desktop's config
    python3 server.py                     # what Claude Desktop runs

Requires WorkFlow running on this Mac with Settings > Agent Bridge switched on.
Nothing moves while the app is closed, in either direction.
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import sys
import types
from pathlib import Path

WF_PATH = Path(__file__).resolve().parents[1] / "agent-bridge" / "wf"
PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "workflow", "version": "1.0.0"}


def load_wf():
    """Import the CLI as a module. Its `__main__` guard means loading it under
    the name "wf" defines everything without running the argument parser."""
    if not WF_PATH.exists():
        raise RuntimeError(f"can't find the wf CLI at {WF_PATH}")
    loader = importlib.machinery.SourceFileLoader("wf", str(WF_PATH))
    spec = importlib.util.spec_from_loader("wf", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


WF = load_wf()


def call_cli(func, **kwargs):
    """Run one CLI function and capture what it printed.

    stdout is the MCP transport here, so nothing the CLI prints may reach it —
    everything is redirected. The CLI also signals with exit codes (`queue` and
    `poll` exit 1 for "nothing to do"), which is a result, not a failure.
    """
    out, err = io.StringIO(), io.StringIO()
    status = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            func(types.SimpleNamespace(**kwargs))
    except SystemExit as exit_signal:
        status = exit_signal.code if isinstance(exit_signal.code, int) else 1
    except Exception as exc:  # a broken store or a missing bridge
        return f"{type(exc).__name__}: {exc}", True

    text = out.getvalue().strip() or err.getvalue().strip()
    # Exit 2 is the CLI's "the app refused this command" — a real error worth
    # surfacing as one. Exit 1 is "nothing to report".
    return (text or "(no output)"), status == 2


# --------------------------------------------------------------------- tools

TOOLS = [
    {
        "name": "workflow_state",
        "description": "Whether the Agent Bridge is running, which store is live, and what the app version is. Use this first if anything else fails.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": lambda a: call_cli(WF.cmd_state),
    },
    {
        "name": "workflow_list_tasks",
        "description": "List tasks with status, priority, project and due date.",
        "inputSchema": {
            "type": "object",
            "properties": {"all": {"type": "boolean", "description": "Include archived and hidden tasks"}},
        },
        "handler": lambda a: call_cli(WF.cmd_tasks, all=a.get("all", False)),
    },
    {
        "name": "workflow_get_task",
        "description": "One task in full, with its comment thread. Accepts a task id or a fragment of its title.",
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string"}},
            "required": ["task"],
        },
        "handler": lambda a: call_cli(WF.cmd_show, task=a["task"]),
    },
    {
        "name": "workflow_queue",
        "description": "Tasks assigned to the agent — its inbox, with each one's status line, subtask checklist and latest comment.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": lambda a: call_cli(WF.cmd_queue),
    },
    {
        "name": "workflow_poll_comments",
        "description": "Comments the user has left since the last check, ignoring the agent's own. Reports nothing when there is nothing new.",
        "inputSchema": {
            "type": "object",
            "properties": {"since": {"type": "string", "description": "ISO-8601; defaults to the stored watermark"}},
        },
        "handler": lambda a: call_cli(WF.cmd_poll, since=a.get("since")),
    },
    {
        "name": "workflow_create_task",
        "description": "Create a task. Set assignee to \"Claude\" to put it in the agent queue.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "project": {"type": "string"},
                "notes": {"type": "string"},
                "due": {"type": "string", "description": "ISO-8601 or yyyy-MM-dd"},
                "priority": {"type": "string", "enum": ["High", "Medium", "Low"]},
                "status": {"type": "string", "description": "To Do / In Progress / Completed"},
                "assignee": {"type": "string"},
                "status_note": {"type": "string", "description": "Seeds the pinned status line"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "subtasks": {"type": "array", "items": {"type": "string"}},
                "comment": {"type": "string", "description": "An opening comment on the new task"},
            },
            "required": ["title"],
        },
        "handler": lambda a: call_cli(
            WF.cmd_add, title=a["title"], project=a.get("project"), notes=a.get("notes"),
            due=a.get("due"), priority=a.get("priority"), status=a.get("status"),
            assignee=a.get("assignee"), status_note=a.get("status_note"),
            tag=a.get("tags"), subtask=a.get("subtasks"), comment=a.get("comment"),
        ),
    },
    {
        "name": "workflow_comment",
        "description": "Post a comment on a task, authored as the agent. This is how you reply to the user — it reaches their phone as a notification.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "text": {"type": "string"},
                "mentions": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["task", "text"],
        },
        "handler": lambda a: call_cli(WF.cmd_comment, task=a["task"], text=a["text"],
                                      mention=a.get("mentions")),
    },
    {
        "name": "workflow_set_status_line",
        "description": "Set a task's pinned note — the one-line 'where this stands' shown above its comments. Overwrite it as work progresses rather than commenting each time.",
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string"}, "text": {"type": "string"}},
            "required": ["task", "text"],
        },
        "handler": lambda a: call_cli(WF.cmd_status, task=a["task"], text=a["text"]),
    },
    {
        "name": "workflow_check_subtasks",
        "description": "Tick subtasks off a task (or untick them), so progress on a long job is visible on the task's own row.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "subtasks": {"type": "array", "items": {"type": "string"}},
                "uncheck": {"type": "boolean"},
            },
            "required": ["task", "subtasks"],
        },
        "handler": lambda a: call_cli(WF.cmd_check, task=a["task"], subtask=a["subtasks"],
                                      uncheck=a.get("uncheck", False)),
    },
    {
        "name": "workflow_rename_subtask",
        "description": "Retitle one subtask in place, keeping its tick state — for correcting a row's wording (a version line on an index, say) without adding a duplicate.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "from": {"type": "string", "description": "current title, exact or a fragment it contains"},
                "to": {"type": "string"},
            },
            "required": ["task", "from", "to"],
        },
        "handler": lambda a: call_cli(WF.cmd_rename, task=a["task"], old=a["from"], new=a["to"]),
    },
    {
        "name": "workflow_complete_task",
        "description": "Mark a task complete.",
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string"}},
            "required": ["task"],
        },
        "handler": lambda a: call_cli(WF.cmd_done, task=a["task"]),
    },
    {
        "name": "workflow_create_project",
        "description": "Create a project, or update an existing one of the same name.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "icon": {"type": "string", "description": "SF Symbol name"},
                "color": {"type": "string", "description": "#RRGGBB"},
                "description": {"type": "string"},
            },
            "required": ["name"],
        },
        "handler": lambda a: call_cli(WF.cmd_project, name=a["name"], icon=a.get("icon"),
                                      color=a.get("color"), description=a.get("description")),
    },
    {
        "name": "workflow_list_notes",
        "description": "The Notepad inbox. A '*' marks notes addressed to the agent.",
        "inputSchema": {
            "type": "object",
            "properties": {"all": {"type": "boolean", "description": "Include archived notes"}},
        },
        "handler": lambda a: call_cli(WF.cmd_notes, all=a.get("all", False)),
    },
    {
        "name": "workflow_get_note",
        "description": "One note in full.",
        "inputSchema": {
            "type": "object",
            "properties": {"note": {"type": "string"}},
            "required": ["note"],
        },
        "handler": lambda a: call_cli(WF.cmd_note, note=a["note"]),
    },
    {
        "name": "workflow_create_note",
        "description": "File a note in the Notepad. Where output that isn't work belongs — a summary, a finding, a set of options. Use a task instead for anything that needs doing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "body": {"type": "string"},
                "color": {"type": "string", "description": "#RRGGBB"},
                "pin": {"type": "boolean"},
            },
            "required": ["title"],
        },
        "handler": lambda a: call_cli(WF.cmd_jot, title=a["title"], body=a.get("body"),
                                      color=a.get("color"), pin=a.get("pin", False)),
    },
    {
        "name": "workflow_convert_note",
        "description": "Promote a note into a task, keeping the note and linking the two. Converting is what takes a note out of the inbox.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": {"type": "string"},
                "project": {"type": "string"},
                "title": {"type": "string", "description": "Override the task title"},
                "priority": {"type": "string", "enum": ["High", "Medium", "Low"]},
                "due": {"type": "string"},
                "assignee": {"type": "string"},
                "subtasks": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["note"],
        },
        "handler": lambda a: call_cli(
            WF.cmd_convert, note=a["note"], project=a.get("project"), title=a.get("title"),
            priority=a.get("priority"), due=a.get("due"), assignee=a.get("assignee"),
            subtask=a.get("subtasks"),
        ),
    },
]

TOOLS.append({
    "name": "workflow_attach_file",
    "description": "Attach a local file to a task (a report, a document, an image). The file is copied into the bridge folder and consumed by the app.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "task": {"type": "string"},
            "file": {"type": "string", "description": "Path to the file on this Mac"},
            "name": {"type": "string", "description": "Display name; defaults to the filename"},
        },
        "required": ["task", "file"],
    },
    "handler": lambda a: call_cli(WF.cmd_attach, task=a["task"], file=a["file"], name=a.get("name")),
})

TOOLS.append({
    "name": "workflow_reply_note",
    "description": "Answer a Notepad note inside the note itself: appends a signed, dated reply to its body without changing what the user wrote. Notes have no comment thread, so this is how a note gets an answer on the user's phone.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "note": {"type": "string"},
            "text": {"type": "string"},
            "pin": {"type": "boolean"},
        },
        "required": ["note", "text"],
    },
    "handler": lambda a: call_cli(WF.cmd_reply, note=a["note"], text=a["text"], pin=a.get("pin", False)),
})

TOOLS_BY_NAME = {tool["name"]: tool for tool in TOOLS}


def public_tools():
    return [{k: v for k, v in tool.items() if k != "handler"} for tool in TOOLS]


# ------------------------------------------------------------------ protocol

def handle(request):
    method = request.get("method")
    request_id = request.get("id")

    if method == "initialize":
        return ok(request_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO,
        })

    if method == "ping":
        return ok(request_id, {})

    if method == "tools/list":
        return ok(request_id, {"tools": public_tools()})

    if method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name")
        tool = TOOLS_BY_NAME.get(name)
        if tool is None:
            return err(request_id, -32602, f"Unknown tool: {name}")
        try:
            text, is_error = tool["handler"](params.get("arguments") or {})
        except KeyError as missing:
            return err(request_id, -32602, f"Missing required argument: {missing}")
        return ok(request_id, {
            "content": [{"type": "text", "text": text}],
            "isError": is_error,
        })

    if method and method.startswith("notifications/"):
        return None  # notifications take no reply

    return err(request_id, -32601, f"Method not found: {method}")


def ok(request_id, result):
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def err(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue  # a malformed frame is not ours to fix; keep the loop alive
        response = handle(request)
        if response is None:
            continue
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def stable_python():
    """Prefer the system Python over whatever happens to be running.

    `sys.executable` picks up Xcode's bundled interpreter when this is run from
    a developer shell, and that path moves with an Xcode update — which would
    break the server months later for no visible reason.
    """
    system = Path("/usr/bin/python3")
    return str(system) if system.exists() else sys.executable


def print_config():
    config = {
        "mcpServers": {
            "workflow": {
                "command": stable_python(),
                "args": [str(Path(__file__).resolve())],
            }
        }
    }
    print("Add this to Claude Desktop's config, then restart Claude Desktop:")
    print("  ~/Library/Application Support/Claude/claude_desktop_config.json\n")
    print(json.dumps(config, indent=2))
    print("\nFor Claude Code:")
    print(f"  claude mcp add workflow -- {stable_python()} {Path(__file__).resolve()}")


if __name__ == "__main__":
    if "--print-config" in sys.argv:
        print_config()
    else:
        serve()
