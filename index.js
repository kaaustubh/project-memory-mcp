#!/usr/bin/env node
// Project Memory MCP server.
// One source of truth = the files under ~/code:
//   - <project>/AGENTS.md   -> auto-loaded "push" memory (identity, decisions, learnings). Kept lean.
//   - <project>/issues.jsonl -> high-volume "pull" memory (bugs/issues). NOT auto-loaded.
// The server is stateless: every tool reads/writes these files, so any client
// (Claude Code, Cursor, ...) pointing at this script shares the same memory.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// CODE_ROOT: where the projects live. Defaults to the parent of this .memory-server
// directory (i.e. ~/code), but PROJECT_MEMORY_ROOT overrides it so the server can be
// cloned anywhere on another machine and still point at the right projects folder.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PROJECT_MEMORY_ROOT
  ? path.resolve(process.env.PROJECT_MEMORY_ROOT)
  : path.resolve(HERE, "..");
const SKIP = new Set(["node_modules", ".git", ".memory-server", "screenshots", ".next", "dist", "build"]);

const today = () => new Date().toISOString().slice(0, 10);
const text = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });

// --- project discovery (filesystem is the source of truth, so it never drifts) ---
function listProjectDirs() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(ROOT, name, "AGENTS.md")))
    .sort();
}
function agentsPath(project) { return path.join(ROOT, project, "AGENTS.md"); }
function issuesPath(project) { return path.join(ROOT, project, "issues.jsonl"); }
function rootAgentsPath() { return path.join(ROOT, "AGENTS.md"); }
function openIssueCount(project) { return readIssues(project).filter((i) => i.status !== "resolved").length; }
function projectExists(project) { return fs.existsSync(agentsPath(project)); }

// Append a dated bullet under a "## <Heading>" section, creating it if absent.
function appendUnderHeading(project, heading, bullet) {
  const file = agentsPath(project);
  let body = fs.readFileSync(file, "utf8");
  const lines = body.split("\n");
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "i");
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) {
    if (!body.endsWith("\n")) body += "\n";
    body += `\n## ${heading}\n${bullet}\n`;
  } else {
    // insert right after the heading, before any existing bullets
    lines.splice(idx + 1, 0, bullet);
    body = lines.join("\n");
  }
  fs.writeFileSync(file, body);
}

function readIssues(project) {
  const file = issuesPath(project);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
function writeIssues(project, entries) {
  fs.writeFileSync(issuesPath(project), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// `npx @kaaustubh/project-memory-mcp install` registers this server with Claude Code +
// Cursor, using the CURRENT directory as the projects root. Run it from your code folder.
const PKG = "@kaaustubh/project-memory-mcp";
if (process.argv[2] === "install") {
  const root = process.cwd();
  // Claude Code (user scope = every project)
  spawnSync("claude", ["mcp", "remove", "project-memory", "-s", "user"], { stdio: "ignore" });
  const r = spawnSync("claude",
    ["mcp", "add", "project-memory", "-s", "user", "-e", `PROJECT_MEMORY_ROOT=${root}`, "--", "npx", "-y", PKG],
    { stdio: "inherit" });
  if (r.error) console.error("Claude Code registration skipped:", r.error.message);
  // Cursor (merge so other MCP servers are preserved)
  const cfgPath = path.join(process.env.HOME || ".", ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers["project-memory"] = { command: "npx", args: ["-y", PKG], env: { PROJECT_MEMORY_ROOT: root } };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\nRegistered project-memory (projects root: ${root}).`);
  console.log("Restart Claude Code / Cursor, then ask your agent to \"set up project memory for this folder\".");
  process.exit(0);
}

// `... hook` — Stop-hook entrypoint for OPT-IN "guaranteed capture". Claude Code runs this
// when the agent is about to stop and pipes the Stop payload on stdin. At most ONCE per
// session (guarded by stop_hook_active) we block the stop to force a capture pass — but
// only when real work happened (file edits / a commit) AND nothing was written to project
// memory yet. Otherwise we allow the stop silently. Capture stays the model's job; the hook
// just guarantees it gets ASKED once. PROJECT_MEMORY_HOOK=off is a per-session kill switch.
if (process.argv[2] === "hook") {
  const allow = () => process.exit(0); // exit 0 with no decision = let the agent stop
  if (process.env.PROJECT_MEMORY_HOOK === "off") allow();
  let data = {};
  try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
  if (data.stop_hook_active) allow(); // we already nudged once this turn — don't loop

  let captured = false, didWork = false;
  const tx = data.transcript_path;
  if (tx && fs.existsSync(tx)) {
    for (const line of fs.readFileSync(tx, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const content = ev?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type !== "tool_use") continue;
        const n = b.name || "";
        if (/project-memory__(log_issue|append_decision|append_learning|resolve_issue)/.test(n)) captured = true;
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) didWork = true;
        if (n === "Bash" && /git\s+commit/.test(b.input?.command || "")) didWork = true;
      }
    }
  }
  if (captured || !didWork) allow(); // nothing changed, or already recorded → no nag

  const reason = "Before ending this session: code changed but nothing was saved to project memory. Review what happened and, if a future session should know it, call the project-memory tools — log_issue (a non-trivial bug + its fix), append_decision (a real/architectural choice + WHY), or append_learning (a durable gotcha). Then report in one line what you logged. If genuinely nothing is worth saving, say so briefly and stop.";
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

// `... install-hook` / `... uninstall-hook` — register/remove the Stop hook above in
// ~/.claude/settings.json (Claude Code). OPT-IN by design: plain `install` does NOT add it.
if (process.argv[2] === "install-hook" || process.argv[2] === "uninstall-hook") {
  const removing = process.argv[2] === "uninstall-hook";
  const settingsPath = path.join(process.env.HOME || ".", ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  // Stable absolute path when installed from source; fall back to npx from the cache.
  const fromCache = /[/\\](_npx|\.npm|node_modules)[/\\]/.test(HERE);
  const command = fromCache ? `npx -y ${PKG} hook` : `node "${path.join(HERE, "index.js")}" hook`;
  const isOurs = (g) => (g?.hooks || []).some((x) => /project-memory.*hook|index\.js" hook/.test(x.command || ""));
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.Stop = (cfg.hooks.Stop || []).filter((g) => !isOurs(g)); // drop any prior copy (idempotent)
  if (!removing) cfg.hooks.Stop.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] });
  if (!cfg.hooks.Stop.length) delete cfg.hooks.Stop;
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(removing
    ? `Removed project-memory Stop hook from ${settingsPath}.`
    : `Installed project-memory Stop hook in ${settingsPath}:\n  ${command}\nGuaranteed-capture is ON. Restart Claude Code. Per-session off: PROJECT_MEMORY_HOOK=off · remove: uninstall-hook.`);
  process.exit(0);
}

// Standing capture policy — sent to the client on initialize, so it's in context every
// session this server is loaded. Makes memory proactive (agent decides) rather than
// requiring the user to ask each time, while staying confirming and conservative.
const INSTRUCTIONS = `This server is the project's long-term memory. Use it PROACTIVELY — don't wait to be asked:
- Before debugging an error the user reports, call search_issues first to check for a prior fix.
- After resolving a non-trivial bug, call log_issue (symptom, cause, fix).
- After a non-obvious or architectural decision, call append_decision.
- After discovering a durable gotcha/workaround, call append_learning.
Always tell the user in one short line what you recorded. When unsure whether something is worth storing, ASK rather than logging noise. Skip trivial/transient issues. Never store secrets or credentials.`;

const server = new McpServer({ name: "project-memory", version: "1.3.0" }, { instructions: INSTRUCTIONS });

// ----------------------------- project memory (AGENTS.md) -----------------------------

server.registerTool("list_projects",
  { title: "List projects", description: "List all projects under ~/code that have an AGENTS.md memory file.", inputSchema: {} },
  async () => {
    const projects = listProjectDirs();
    if (!projects.length) return text("No projects with AGENTS.md found under " + ROOT);
    const rows = projects.map((p) => {
      const body = fs.readFileSync(agentsPath(p), "utf8");
      const m = body.match(/##\s+What this is\s*\n+([^\n]+)/i);
      const open = openIssueCount(p);
      return `- ${p}${open ? ` (${open} open issue${open > 1 ? "s" : ""})` : ""}: ${m ? m[1].trim() : "(no summary)"}`;
    });
    return text(rows.join("\n"));
  });

server.registerTool("get_project",
  { title: "Get project memory", description: "Return the full AGENTS.md memory for one project.", inputSchema: { project: z.string().describe("Project directory name, e.g. pulse_stripe") } },
  async ({ project }) => {
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}". Known: ${listProjectDirs().join(", ")}`);
    return text(fs.readFileSync(agentsPath(project), "utf8"));
  });

server.registerTool("search_memory",
  { title: "Search project memory", description: "Case-insensitive search across every project's AGENTS.md. Returns matching lines with their project.", inputSchema: { query: z.string() } },
  async ({ query }) => {
    const q = query.toLowerCase();
    const hits = [];
    for (const p of listProjectDirs()) {
      fs.readFileSync(agentsPath(p), "utf8").split("\n").forEach((line, i) => {
        if (line.toLowerCase().includes(q)) hits.push(`${p}:${i + 1}: ${line.trim()}`);
      });
    }
    return text(hits.length ? hits.join("\n") : `No matches for "${query}".`);
  });

server.registerTool("append_decision",
  { title: "Append a decision", description: "Append a dated bullet under '## Decisions' in a project's AGENTS.md (auto-loaded memory). Call this PROACTIVELY right after a non-obvious or architectural decision is made — don't wait to be asked — then tell the user in one line what you recorded. For concise, durable decisions and WHY; not bugs (use log_issue) and not trivia.", inputSchema: { project: z.string(), text: z.string().describe("One line: the decision and WHY, not just what.") } },
  async ({ project, text: t }) => {
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}".`);
    appendUnderHeading(project, "Decisions", `- ${today()}: ${t}`);
    return text(`Recorded decision in ${project}/AGENTS.md.`);
  });

server.registerTool("append_learning",
  { title: "Append a learning", description: "Append a dated bullet under '## Learnings' in a project's AGENTS.md (auto-loaded memory). Call this PROACTIVELY when you discover a durable gotcha/workaround future sessions should know — don't wait to be asked — then tell the user what you recorded. For a specific bug use log_issue instead.", inputSchema: { project: z.string(), text: z.string() } },
  async ({ project, text: t }) => {
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}".`);
    appendUnderHeading(project, "Learnings", `- ${today()}: ${t}`);
    return text(`Recorded learning in ${project}/AGENTS.md.`);
  });

// ----------------------------- issue log (issues.jsonl, NOT auto-loaded) -----------------------------

server.registerTool("log_issue",
  { title: "Log a bug/issue", description: "Append a structured bug/issue to <project>/issues.jsonl (high-volume memory, NOT auto-loaded). Call this PROACTIVELY whenever you resolve (or get blocked by) a non-trivial bug — don't wait to be asked — then tell the user in one line what you logged. Skip trivial/transient issues.", inputSchema: {
      project: z.string(),
      symptom: z.string().describe("What went wrong / the observable failure."),
      cause: z.string().optional().describe("Root cause, if known."),
      fix: z.string().optional().describe("How it was fixed, if resolved."),
      status: z.enum(["open", "resolved"]).optional().describe("Defaults to 'resolved' if a fix is given, else 'open'."),
      files: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
  } },
  async ({ project, symptom, cause, fix, status, files, tags }) => {
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}". Create the project memory first.`);
    const entries = readIssues(project);
    const id = `${project}-${String(entries.length + 1).padStart(3, "0")}`;
    const entry = { id, date: today(), status: status || (fix ? "resolved" : "open"), symptom };
    if (cause) entry.cause = cause;
    if (fix) { entry.fix = fix; if (entry.status === "resolved") entry.resolvedDate = today(); }
    if (files?.length) entry.files = files;
    if (tags?.length) entry.tags = tags;
    fs.appendFileSync(issuesPath(project), JSON.stringify(entry) + "\n");
    return text(`Logged ${id} (${entry.status}).`);
  });

server.registerTool("search_issues",
  { title: "Search issues", description: "Search bug/issue history across all projects (or one) over the TEXT FIELDS only (symptom, cause, fix, id, tags) — not the raw JSON, so you won't get false hits on field names like 'fix' or 'status'. Optionally filter by tags (issue must carry all of them). Either query or tags may be given. Call this PROACTIVELY when the user reports an error or you hit a familiar-looking failure, BEFORE debugging from scratch, to check for a prior fix ('have we hit this before?').", inputSchema: { query: z.string().optional().describe("Text to match against symptom/cause/fix/id/tags."), project: z.string().optional(), tags: z.array(z.string()).optional().describe("Only return issues carrying ALL of these tags.") } },
  async ({ query, project, tags }) => {
    const q = (query || "").toLowerCase();
    const wantTags = (tags || []).map((t) => t.toLowerCase());
    if (!q && !wantTags.length) return err("Provide a query and/or tags to search.");
    const scope = project ? [project] : listProjectDirs();
    const hits = [];
    for (const p of scope) {
      for (const e of readIssues(p)) {
        const haystack = [e.id, e.symptom, e.cause, e.fix, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
        if (q && !haystack.includes(q)) continue;
        const etags = (e.tags || []).map((t) => t.toLowerCase());
        if (wantTags.length && !wantTags.every((t) => etags.includes(t))) continue;
        hits.push({ project: p, ...e });
      }
    }
    const label = [q && `"${query}"`, wantTags.length && `tags: ${tags.join(", ")}`].filter(Boolean).join(" ");
    if (!hits.length) return text(`No issues match ${label}.`);
    return text(hits.map((h) => `[${h.id}] (${h.status}) ${h.symptom}${h.fix ? ` — fix: ${h.fix}` : ""}${h.tags?.length ? ` {${h.tags.join(", ")}}` : ""}`).join("\n"));
  });

server.registerTool("list_open_issues",
  { title: "List open issues", description: "List unresolved issues across all projects (or one).", inputSchema: { project: z.string().optional() } },
  async ({ project }) => {
    const scope = project ? [project] : listProjectDirs();
    const hits = [];
    for (const p of scope) for (const e of readIssues(p)) if (e.status !== "resolved") hits.push(`[${e.id}] ${e.symptom}`);
    return text(hits.length ? hits.join("\n") : "No open issues. 🎉");
  });

server.registerTool("resolve_issue",
  { title: "Resolve an issue", description: "Mark an issue resolved and record the fix.", inputSchema: { id: z.string().describe("Issue id, e.g. pulse_stripe-003"), fix: z.string() } },
  async ({ id, fix }) => {
    for (const p of listProjectDirs()) {
      const entries = readIssues(p);
      const e = entries.find((x) => x.id === id);
      if (e) { e.status = "resolved"; e.fix = fix; e.resolvedDate = today(); writeIssues(p, entries); return text(`Resolved ${id}.`); }
    }
    return err(`Issue "${id}" not found.`);
  });

// ----------------------------- registry sync & code↔memory linking -----------------------------

server.registerTool("sync_registry",
  { title: "Sync project registry", description: "Reconcile the root AGENTS.md projects table with what's actually on disk: list projects that have an AGENTS.md but no table row (and add a stub row for each), flag rows whose directory no longer exists, and show live open-issue counts. Automates the 'new project → add a row' step so the cross-project index never silently drifts. Hand-curated columns (Stack, Status, descriptions) are preserved — stubs use the project's '## What this is' line and leave Stack/Status as '?'. Set apply=false to report drift without writing.", inputSchema: { apply: z.boolean().optional().describe("Write stub rows for new projects (default true). false = report only.") } },
  async ({ apply }) => {
    const doWrite = apply !== false;
    const file = rootAgentsPath();
    if (!fs.existsSync(file)) return err(`No root AGENTS.md at ${file}.`);
    const lines = fs.readFileSync(file, "utf8").split("\n");

    // Locate the projects table by its header row, then consume the contiguous |-rows after the separator.
    const headerIdx = lines.findIndex((l) => /^\|\s*Project\s*\|/i.test(l));
    if (headerIdx === -1) return err("Couldn't find a '| Project |' table in the root AGENTS.md.");
    let end = headerIdx + 2; // skip header + separator
    while (end < lines.length && lines[end].trimStart().startsWith("|")) end++;

    const rowProjects = new Set();
    for (let i = headerIdx + 2; i < end; i++) {
      const m = lines[i].match(/\|\s*\*\*([^*]+)\*\*\s*\|/);
      if (m) rowProjects.add(m[1].trim());
    }

    const onDisk = listProjectDirs();
    const missing = onDisk.filter((p) => !rowProjects.has(p));         // on disk, not in table
    const stale = [...rowProjects].filter((p) => !onDisk.includes(p)); // in table, dir gone

    const stubFor = (p) => {
      const b = fs.readFileSync(agentsPath(p), "utf8");
      const m = b.match(/##\s+What this is\s*\n+([^\n]+)/i);
      return `| **${p}** | ${m ? m[1].trim() : "(no summary — fill in)"} | ? | ? | [AGENTS.md](${p}/AGENTS.md) |`;
    };

    if (doWrite && missing.length) {
      lines.splice(end, 0, ...missing.map(stubFor));
      fs.writeFileSync(file, lines.join("\n"));
    }

    const report = [`On disk: ${onDisk.length} project(s). In table: ${rowProjects.size} row(s).`];
    if (missing.length) report.push(`Missing from table${doWrite ? " (added stub rows)" : ""}:\n` + missing.map((p) => `  + ${p}`).join("\n"));
    if (stale.length) report.push("Rows with no directory (review manually — not auto-removed):\n" + stale.map((p) => `  ! ${p}`).join("\n"));
    const open = onDisk.filter((p) => openIssueCount(p) > 0);
    if (open.length) report.push("Open issues:\n" + open.map((p) => `  • ${p}: ${openIssueCount(p)}`).join("\n"));
    if (!missing.length && !stale.length) report.unshift("Registry is in sync. ✅");
    return text(report.join("\n\n"));
  });

server.registerTool("find_by_file",
  { title: "Find memory by file", description: "Given a file path or filename fragment, return the issues (matched via their 'files' field) and the decisions/learnings (matched via AGENTS.md bullets that mention it) that touch that file — i.e. 'why is this code the way it is?' answered from memory. Searches all projects unless one is given. Useful when you land on confusing code and want the history behind it.", inputSchema: { file: z.string().describe("A path or filename fragment, e.g. 'index.js' or 'auth/login'."), project: z.string().optional() } },
  async ({ file, project }) => {
    const needle = file.toLowerCase();
    const scope = project ? [project] : listProjectDirs();
    const issueHits = [];
    const noteHits = [];
    for (const p of scope) {
      for (const e of readIssues(p)) {
        if ((e.files || []).some((f) => f.toLowerCase().includes(needle))) {
          issueHits.push(`[${e.id}] (${e.status}) ${e.symptom}${e.fix ? ` — fix: ${e.fix}` : ""}`);
        }
      }
      let section = null;
      fs.readFileSync(agentsPath(p), "utf8").split("\n").forEach((l) => {
        const h = l.match(/^##\s+(.+?)\s*$/);
        if (h) { section = h[1]; return; }
        if (/^(Decisions|Learnings)/i.test(section || "") && l.trim().startsWith("- ") && l.toLowerCase().includes(needle)) {
          noteHits.push(`${p} (${section}): ${l.trim().replace(/^-\s*/, "")}`);
        }
      });
    }
    if (!issueHits.length && !noteHits.length) return text(`No memory references "${file}".`);
    const out = [];
    if (issueHits.length) out.push("Issues:\n" + issueHits.join("\n"));
    if (noteHits.length) out.push("Decisions/Learnings:\n" + noteHits.join("\n"));
    return text(out.join("\n\n"));
  });

await server.connect(new StdioServerTransport());
