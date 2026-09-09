#!/usr/bin/env node
// WorkFlow MCP server — lets Claude Desktop, Claude Code or any MCP client
// drive WorkFlow through the Agent Bridge. Speaks MCP (JSON-RPC 2.0) over
// stdio. Plain Node, no dependencies, one file — it ships inside the app and
// is written into the bridge folder as tools/index.js, and packed into
// WorkFlow.mcpb for one-click install in Claude Desktop.
//
// Reads come from snapshot.json (the app's own export, rewritten after every
// save). Writes are JSON command files dropped into inbox/; the app applies
// them and answers with a receipt in outbox/. Nothing here touches the
// database, and the app's Settings toggles and Command History govern every
// write exactly as they do for the command line.
//
// Where the bridge is, in order: $WF_BRIDGE (baked into the bundle at export),
// the app's location.json pointer, the app's container.

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "workflow", version: "1.1.0" };
const AGENT = { name: "Claude", authorID: "agent.claude" };

// ------------------------------------------------------------------ bridge

function containerRoot() {
  return path.join(os.homedir(), "Library/Containers/mac.TeamDZX.worflow/Data/Library/Application Support/AgentBridge");
}

function bridgeRoot() {
  if (process.env.WF_BRIDGE) return process.env.WF_BRIDGE;
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(containerRoot(), "location.json"), "utf8"));
    if (pointer.root && fs.existsSync(pointer.root)) return pointer.root;
  } catch (_) { /* no pointer: the bridge is still inside the container */ }
  return containerRoot();
}

const ROOT = bridgeRoot();
const P = {
  snapshot: path.join(ROOT, "snapshot.json"),
  state: path.join(ROOT, "state.json"),
  inbox: path.join(ROOT, "inbox"),
  outbox: path.join(ROOT, "outbox"),
  attachments: path.join(ROOT, "attachments"),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function snapshot() {
  const s = readJSON(P.snapshot, null);
  if (!s) throw new Error(`No snapshot at ${P.snapshot}. Is WorkFlow running with Settings → Agent Bridge switched on?`);
  return s;
}

function state() { return readJSON(P.state, {}); }

// A command file is written atomically (temp + rename) so the app never sees
// a half-written file. Then wait for the receipt the app writes.
function send(op, fields, waitMs = 8000) {
  if (!fs.existsSync(P.inbox)) throw new Error(`No inbox at ${P.inbox}. Is the Agent Bridge switched on?`);
  const id = `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const command = Object.assign({ id, op }, prune(fields));
  const final = path.join(P.inbox, `${id}.json`);
  const temp = path.join(P.inbox, `.${id}.json.tmp`);
  fs.writeFileSync(temp, JSON.stringify(command, null, 2));
  fs.renameSync(temp, final);
  const receiptPath = path.join(P.outbox, `${id}.json`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(receiptPath)) {
      const r = readJSON(receiptPath, null);
      if (r) return r;
    }
    sleep(120);
  }
  return { status: "pending", message: `No receipt within ${waitMs / 1000}s — the app may be closed or the bridge off. The command stays in inbox/ and is applied when the app next looks.` };
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

// ------------------------------------------------------------------ lookup

function findIn(rows, needle, label) {
  const n = String(needle).trim().toLowerCase();
  let hit = rows.find(r => String(r.id).toLowerCase() === n);
  if (hit) return hit;
  const exact = rows.filter(r => (r.title || "").toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter(r => (r.title || "").toLowerCase().includes(n));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${needle}" matches ${partial.length} ${label}s: ${partial.slice(0, 5).map(r => `“${r.title}”`).join(", ")} — be more specific.`);
  throw new Error(`No ${label} matches "${needle}".`);
}

function findTask(needle, includeHidden = true) {
  const rows = snapshot().tasks.filter(t => includeHidden || !t.isHidden);
  return findIn(rows, needle, "task");
}

function findNote(needle) {
  return findIn(snapshot().notes || [], needle, "note");
}

function local(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

// ------------------------------------------------------------------ views

function taskLine(t) {
  const due = t.dueDate ? ` due ${local(t.dueDate).split(",")[0]}` : "";
  const proj = t.project ? ` [${t.project}]` : "";
  const who = t.assignee ? ` → ${t.assignee}` : "";
  return `${t.status.padEnd(12)} ${t.title}${proj}${due}${who}`;
}

function showTask(t) {
  const lines = [`${t.title}  (${t.status}, ${t.priority})`, `id ${t.id}`];
  if (t.project) lines.push(`project: ${t.project}`);
  if (t.assignee) lines.push(`assignee: ${t.assignee}`);
  if (t.dueDate) lines.push(`due: ${local(t.dueDate)}`);
  if (t.tags && t.tags.length) lines.push(`tags: ${t.tags.join(", ")}`);
  if (t.pinnedNote) lines.push(`status: ${t.pinnedNote}`);
  if (t.notes) lines.push("", t.notes);
  if (t.subtasks && t.subtasks.length) {
    lines.push("");
    for (const s of t.subtasks) lines.push(`  [${s.isCompleted ? "x" : " "}] ${s.title}`);
  }
  const comments = t.comments || [];
  lines.push("", `${comments.length} comment(s):`);
  for (const c of comments) lines.push("", `  ${c.author} · ${local(c.timestamp)}`, `    ${(c.text || "").replace(/\n/g, "\n    ")}`);
  return lines.join("\n");
}

function showNote(n) {
  const lines = [n.title || "(untitled)", `id ${n.id}`];
  if (n.isPinned) lines.push("pinned");
  if (n.isArchived) lines.push("archived");
  if (n.convertedTargetName) lines.push(`converted → ${n.convertedTargetName}`);
  lines.push(`updated: ${local(n.updatedAt)}`, "", n.body || "");
  return lines.join("\n");
}

function receiptText(r) {
  const tag = r.status === "applied" ? "[ok]" : `[${r.status}]`;
  const extra = [r.taskID && `task ${r.taskID}`, r.noteID && `note ${r.noteID}`, r.projectID && `project ${r.projectID}`].filter(Boolean);
  return `${tag} ${r.message || ""}${extra.length ? "\n       " + extra.join("  ") : ""}`;
}

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: "workflow_state",
    description: "Whether the Agent Bridge is running, where it lives, and the app version. Use this first if anything else fails.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const s = state();
      const snap = readJSON(P.snapshot, null);
      return [
        `bridge      ${ROOT}`,
        `enabled     ${s.enabled === undefined ? "unknown (no state.json)" : s.enabled}`,
        `app         ${s.appVersion || "?"} (${s.build || "?"})`,
        `wake        ${s.wakeEnabled ? "on" : "off"}`,
        `snapshot    ${snap ? `${snap.tasks.length} tasks, ${(snap.notes || []).length} notes, generated ${local(snap.generatedAt)}` : "none yet"}`,
      ].join("\n");
    },
  },
  {
    name: "workflow_list_tasks",
    description: "List tasks with status, priority, project and due date.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include hidden and completed tasks" } } },
    handler: a => {
      const rows = snapshot().tasks.filter(t => a.all || (!t.isHidden && t.status !== "Completed"));
      return rows.length ? rows.map(taskLine).join("\n") : "no tasks";
    },
  },
  {
    name: "workflow_get_task",
    description: "One task in full, with its checklist and comment thread. Accepts a task id or a fragment of its title.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    handler: a => showTask(findTask(a.task)),
  },
  {
    name: "workflow_queue",
    description: "Tasks assigned to the agent — its inbox, with each one's status line, checklist and latest comment.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const rows = snapshot().tasks.filter(t => (t.assignee || "").toLowerCase() === AGENT.name.toLowerCase() && t.status !== "Completed" && !t.isHidden);
      if (!rows.length) return "queue empty";
      return rows.map(t => {
        const last = (t.comments || []).slice(-1)[0];
        const open = (t.subtasks || []).filter(s => !s.isCompleted).length;
        return [`${t.title} [${t.project || "—"}]  id ${t.id}`, t.pinnedNote ? `  status: ${t.pinnedNote}` : null, open ? `  ${open} open subtask(s)` : null, last ? `  last: ${last.author}: ${last.text.slice(0, 160)}` : null].filter(Boolean).join("\n");
      }).join("\n\n");
    },
  },
  {
    name: "workflow_poll_comments",
    description: "Comments the user has written recently, ignoring the agent's own. Defaults to the last 24 hours.",
    inputSchema: { type: "object", properties: { since: { type: "string", description: "ISO-8601" } } },
    handler: a => {
      const since = a.since ? new Date(a.since) : new Date(Date.now() - 86400000);
      const out = [];
      for (const t of snapshot().tasks) for (const c of t.comments || []) {
        if (c.authorID === AGENT.authorID) continue;
        if (new Date(c.timestamp) > since) out.push(`${local(c.timestamp)}  [${t.title}]  ${c.author}: ${c.text}`);
      }
      return out.length ? out.join("\n") : "nothing new";
    },
  },
  {
    name: "workflow_create_task",
    description: 'Create a task. Set assignee to "Claude" to put it in the agent queue.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, project: { type: "string" }, notes: { type: "string" },
        due: { type: "string", description: "ISO-8601 or yyyy-MM-dd" },
        priority: { type: "string", enum: ["High", "Medium", "Low"] },
        status: { type: "string", description: "To Do / In Progress / Completed" },
        assignee: { type: "string" }, status_note: { type: "string", description: "Seeds the pinned status line" },
        tags: { type: "array", items: { type: "string" } }, subtasks: { type: "array", items: { type: "string" } },
        comment: { type: "string", description: "An opening comment on the new task" },
      },
      required: ["title"],
    },
    handler: a => receiptText(send("create_task", { title: a.title, project: a.project, notes: a.notes, dueDate: a.due, priority: a.priority, status: a.status, assignee: a.assignee, pinnedNote: a.status_note, tags: a.tags, subtasks: a.subtasks, text: a.comment })),
  },
  {
    name: "workflow_comment",
    description: "Post a comment on a task, authored as the agent. This is how you reply to the user — it reaches their phone as a notification.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, text: { type: "string" }, mentions: { type: "array", items: { type: "string" } } }, required: ["task", "text"] },
    handler: a => receiptText(send("add_comment", { taskID: findTask(a.task).id, text: a.text, mentions: a.mentions })),
  },
  {
    name: "workflow_set_status_line",
    description: "Set a task's pinned note — the one-line 'where this stands' shown above its comments. Overwrite it as work progresses rather than commenting each time.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, text: { type: "string" } }, required: ["task", "text"] },
    handler: a => receiptText(send("update_task", { taskID: findTask(a.task).id, pinnedNote: a.text })),
  },
  {
    name: "workflow_check_subtasks",
    description: "Tick subtasks off a task (or untick them), so progress on a long job is visible on the task's own row.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, subtasks: { type: "array", items: { type: "string" } }, uncheck: { type: "boolean" } }, required: ["task", "subtasks"] },
    handler: a => receiptText(send("update_task", Object.assign({ taskID: findTask(a.task).id }, a.uncheck ? { uncheckSubtasks: a.subtasks } : { checkSubtasks: a.subtasks }))),
  },
  {
    name: "workflow_add_subtasks",
    description: "Add subtasks to an existing task's checklist.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, subtasks: { type: "array", items: { type: "string" } } }, required: ["task", "subtasks"] },
    handler: a => receiptText(send("update_task", { taskID: findTask(a.task).id, addSubtasks: a.subtasks })),
  },
  {
    name: "workflow_rename_subtask",
    description: "Retitle one subtask in place, keeping its tick state — for correcting a row's wording (a version line on an index, say) without adding a duplicate.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, from: { type: "string", description: "current title, exact or a fragment it contains" }, to: { type: "string" } }, required: ["task", "from", "to"] },
    handler: a => receiptText(send("update_task", { taskID: findTask(a.task).id, renameSubtasks: [{ from: a.from, to: a.to }] })),
  },
  {
    name: "workflow_complete_task",
    description: "Mark a task complete.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    handler: a => receiptText(send("complete_task", { taskID: findTask(a.task).id })),
  },
  {
    name: "workflow_create_project",
    description: "Create a project, or update an existing one of the same name.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, icon: { type: "string", description: "SF Symbol name" }, color: { type: "string", description: "#RRGGBB" }, description: { type: "string" } }, required: ["name"] },
    handler: a => receiptText(send("create_project", { name: a.name, icon: a.icon, colorHex: a.color, projectDescription: a.description })),
  },
  {
    name: "workflow_list_notes",
    description: "The Notepad. A '*' marks notes addressed to the agent (containing @claude).",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Include archived notes" } } },
    handler: a => {
      const rows = (snapshot().notes || []).filter(n => a.all || !n.isArchived);
      if (!rows.length) return "no notes";
      return rows.map(n => `${/@claude/i.test(n.body || "") ? "*" : " "} ${(n.title || "(untitled)").padEnd(40)}  ${local(n.updatedAt)}  id ${n.id}`).join("\n");
    },
  },
  {
    name: "workflow_get_note",
    description: "One note in full.",
    inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    handler: a => showNote(findNote(a.note)),
  },
  {
    name: "workflow_create_note",
    description: "File a note in the Notepad. Where output that isn't work belongs — a summary, a finding, a set of options. Use a task instead for anything that needs doing.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, color: { type: "string", description: "#RRGGBB" }, pin: { type: "boolean" } }, required: ["title"] },
    handler: a => receiptText(send("create_note", { title: a.title, notes: a.body, colorHex: a.color, isPinned: a.pin })),
  },
  {
    name: "workflow_reply_note",
    description: "Answer a Notepad note inside the note itself: appends a signed, dated reply without changing what the user wrote. Notes have no comment thread, so this is how a note gets an answer on the user's phone.",
    inputSchema: { type: "object", properties: { note: { type: "string" }, text: { type: "string" }, pin: { type: "boolean" } }, required: ["note", "text"] },
    handler: a => receiptText(send("update_note", { noteID: findNote(a.note).id, appendText: a.text, isPinned: a.pin })),
  },
  {
    name: "workflow_convert_note",
    description: "Promote a note into a task, keeping the note and linking the two. Converting is what takes a note out of the inbox.",
    inputSchema: { type: "object", properties: { note: { type: "string" }, project: { type: "string" }, title: { type: "string" }, priority: { type: "string", enum: ["High", "Medium", "Low"] }, due: { type: "string" }, assignee: { type: "string" }, subtasks: { type: "array", items: { type: "string" } } }, required: ["note"] },
    handler: a => receiptText(send("convert_note", { noteID: findNote(a.note).id, project: a.project, title: a.title, priority: a.priority, dueDate: a.due, assignee: a.assignee, subtasks: a.subtasks })),
  },
  {
    name: "workflow_attach_file",
    description: "Attach a local file to a task (a report, a document, an image). The file is copied into the bridge folder and consumed by the app.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, file: { type: "string", description: "Path to the file on this Mac" }, name: { type: "string", description: "Display name; defaults to the filename" } }, required: ["task", "file"] },
    handler: a => {
      const src = path.resolve(a.file.replace(/^~/, os.homedir()));
      if (!fs.existsSync(src)) throw new Error(`no such file: ${src}`);
      fs.mkdirSync(P.attachments, { recursive: true });
      const staged = path.join(P.attachments, path.basename(src));
      if (path.resolve(staged) !== src) fs.copyFileSync(src, staged);
      return receiptText(send("attach_file", { taskID: findTask(a.task).id, fileName: path.basename(src), displayName: a.name }, 15000));
    },
  },
  {
    name: "workflow_ping",
    description: "Confirm the app is watching the bridge (round-trips one command).",
    inputSchema: { type: "object", properties: {} },
    handler: () => receiptText(send("ping", {}, 5000)),
  },
];

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));
const publicTools = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// ------------------------------------------------------------------ protocol

function handle(request) {
  const { method, id } = request;
  const ok = result => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: publicTools() });
  if (method === "tools/call") {
    const params = request.params || {};
    const tool = TOOLS_BY_NAME[params.name];
    if (!tool) return err(-32602, `Unknown tool: ${params.name}`);
    const args = params.arguments || {};
    for (const req of (tool.inputSchema.required || [])) if (args[req] === undefined) return err(-32602, `Missing required argument: ${req}`);
    try {
      return ok({ content: [{ type: "text", text: String(tool.handler(args)) }], isError: false });
    } catch (e) {
      return ok({ content: [{ type: "text", text: `${e.message || e}` }], isError: true });
    }
  }
  if (method && method.startsWith("notifications/")) return null;
  return err(-32601, `Method not found: ${method}`);
}

function serve() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch (_) { continue; }
      const response = handle(request);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv.includes("--print-config")) {
  const cfg = { mcpServers: { workflow: { command: "node", args: [__filename], env: { WF_BRIDGE: ROOT } } } };
  process.stdout.write("Claude Desktop → Settings → Developer → Edit Config, add:\n" + JSON.stringify(cfg, null, 2) + "\n\nClaude Code:\n  claude mcp add workflow -e WF_BRIDGE=\"" + ROOT + "\" -- node \"" + __filename + "\"\n");
} else {
  serve();
}
