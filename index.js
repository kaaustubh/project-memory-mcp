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
import crypto from "node:crypto";
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

// Append a dated bullet under a "## <Heading>" section of any AGENTS.md, creating it if absent.
function appendBulletToFile(file, heading, bullet) {
  let body = fs.readFileSync(file, "utf8");
  const lines = body.split("\n");
  // Match the heading by its leading word so "## Learnings (gotchas …)" still resolves
  // to the existing section instead of spawning a duplicate "## Learnings".
  const re = new RegExp(`^##\\s+${heading}\\b`, "i");
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
function appendUnderHeading(project, heading, bullet) {
  appendBulletToFile(agentsPath(project), heading, bullet);
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

// --- semantic embeddings (OPTIONAL, offline after first model fetch) -----------------
// The recall hook and `reindex` use these to match a prompt against memory by MEANING,
// not shared substrings. Everything is soft: if @xenova/transformers isn't installed (or
// fails to load), getEmbedder() returns null and callers fall back to keyword scoring.
// Vectors are cached per project in <project>/.embeddings.json (a DERIVED cache — the
// .jsonl / AGENTS.md stay the source of truth; delete the cache and it rebuilds), keyed by
// a hash of the item text so edited/removed lines self-invalidate.
const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
let _embedder = null, _embedderTried = false;
async function getEmbedder() {
  if (_embedderTried) return _embedder;
  _embedderTried = true;
  try {
    const { pipeline } = await import("@xenova/transformers");
    _embedder = await pipeline("feature-extraction", EMBED_MODEL);
  } catch { _embedder = null; }
  return _embedder;
}
async function embed(str) {
  const e = await getEmbedder();
  if (!e) return null;
  const out = await e(str, { pooling: "mean", normalize: true }); // unit vector → dot == cosine
  return Array.from(out.data);
}
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function hashText(t) { return crypto.createHash("sha256").update(t).digest("hex").slice(0, 16); }
function embCachePath(project) { return path.join(ROOT, project, ".embeddings.json"); }
function readEmbCache(project) {
  const f = embCachePath(project);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; }
}
function writeEmbCache(project, cache) { fs.writeFileSync(embCachePath(project), JSON.stringify(cache)); }

// Collect the embeddable / scorable memory items for a project: every issue plus every
// decision/learning/preference bullet. `body` is what we match against; `text` is what we
// show. Shared by the recall hook and `reindex` so the two never drift.
function memoryItems(project) {
  const items = [];
  for (const e of readIssues(project)) {
    const body = [e.id, e.symptom, e.cause, e.fix, ...(e.tags || [])].filter(Boolean).join(" ");
    items.push({ kind: "issue", body, text: `[${e.id}] (${e.status}) ${e.symptom}${e.fix ? ` — fix: ${e.fix}` : ""}` });
  }
  let section = null;
  for (const l of fs.readFileSync(agentsPath(project), "utf8").split("\n")) {
    const h = l.match(/^##\s+(.+?)\s*$/);
    if (h) { section = (h[1].split(/\s/)[0] || "").toLowerCase(); continue; }
    if (/^(decisions|learnings|preferences)$/.test(section || "") && l.trim().startsWith("- ")) {
      items.push({ kind: section.replace(/s$/, ""), body: l.trim(), text: l.trim().replace(/^-\s*/, "") });
    }
  }
  return items;
}

// `npx @kaaustubh/project-memory-mcp install` registers this server with Claude Code +
// Cursor, using the CURRENT directory as the projects root. Run it from your code folder.
const PKG = "@kaaustubh/project-memory-mcp";
// Merges a project-memory entry into a JSON config file under `topKey` (e.g. "mcpServers"
// or "servers"), preserving whatever else is already there. Non-fatal: a client whose
// config dir can't be created/written (e.g. not installed on this machine) just gets skipped.
function registerMcp(cfgPath, topKey, entry, label) {
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
    cfg[topKey] = cfg[topKey] || {};
    cfg[topKey]["project-memory"] = entry;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e) {
    console.error(`${label} registration skipped:`, e.message);
  }
}

if (process.argv[2] === "install") {
  const root = process.cwd();
  const npxEntry = { command: "npx", args: ["-y", PKG], env: { PROJECT_MEMORY_ROOT: root } };

  // Claude Code (user scope = every project)
  spawnSync("claude", ["mcp", "remove", "project-memory", "-s", "user"], { stdio: "ignore" });
  const r = spawnSync("claude",
    ["mcp", "add", "project-memory", "-s", "user", "-e", `PROJECT_MEMORY_ROOT=${root}`, "--", "npx", "-y", PKG],
    { stdio: "inherit" });
  if (r.error) console.error("Claude Code registration skipped:", r.error.message);

  // Cursor — "mcpServers" schema, no "type" field.
  registerMcp(path.join(process.env.HOME || ".", ".cursor", "mcp.json"), "mcpServers", npxEntry, "Cursor");

  // GitHub Copilot CLI — "mcpServers" schema too, but each entry needs "type": "local"
  // (COPILOT_HOME overrides the default ~/.copilot dir, same as the CLI itself respects).
  const copilotCliDir = process.env.COPILOT_HOME || path.join(process.env.HOME || ".", ".copilot");
  registerMcp(path.join(copilotCliDir, "mcp-config.json"), "mcpServers", { type: "local", ...npxEntry }, "GitHub Copilot CLI");

  // VS Code / Copilot Chat — user-profile mcp.json applies to every workspace. Schema differs
  // from Claude/Cursor: top-level key is "servers", entries need "type": "stdio".
  const vscodeDir = process.platform === "darwin"
    ? path.join(process.env.HOME || ".", "Library", "Application Support", "Code", "User")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "Code", "User")
      : path.join(process.env.HOME || ".", ".config", "Code", "User");
  registerMcp(path.join(vscodeDir, "mcp.json"), "servers", { type: "stdio", ...npxEntry }, "VS Code / Copilot");

  // JetBrains Copilot plugin (IntelliJ, PyCharm, WebStorm, ...) — same "servers"/"type":"stdio"
  // schema as VS Code, different config dir.
  const jbDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "github-copilot", "intellij")
    : path.join(process.env.HOME || ".", ".config", "github-copilot", "intellij");
  registerMcp(path.join(jbDir, "mcp.json"), "servers", { type: "stdio", ...npxEntry }, "JetBrains Copilot");

  // Visual Studio (Windows-only IDE) — global config applies to every solution, same schema.
  if (process.platform === "win32" && process.env.USERPROFILE) {
    registerMcp(path.join(process.env.USERPROFILE, ".mcp.json"), "servers", { type: "stdio", ...npxEntry }, "Visual Studio");
  }

  console.log(`\nRegistered project-memory (projects root: ${root}).`);
  console.log("Restart your editor(s), then ask your agent to \"set up project memory for this folder\".");
  console.log("Covers: Claude Code, Cursor, VS Code Copilot Chat, GitHub Copilot CLI, JetBrains Copilot plugin"
    + (process.platform === "win32" ? ", and Visual Studio." : "."));
  console.log("(Copilot surfaces: tools only run in Agent mode; restart required for config changes to load.)");
  console.log("\nWant team memory (shared across your team, not just your machine)? Register for the beta: https://github.com/kaaustubh/project-memory-mcp/issues/1");
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

  // Behavioural-correction phrases in the user's typed text — a one-off correction the
  // agent should turn into a remembered preference. Kept reasonably specific to avoid noise.
  const CORRECTION_RE = /\b(no,?\s+(please\s+)?don'?t|don'?t\s+do\s+that|stop\s+doing\s+that|i\s+told\s+you|from\s+now\s+on|never\s+(do|add|use|put)|always\s+(use|do|run)|i'?d\s+rather|instead,?\s+(use|do)|that'?s\s+not\s+how)\b/i;

  let captured = false, didWork = false, corrected = false, prefSaved = false;
  const tx = data.transcript_path;
  if (tx && fs.existsSync(tx)) {
    for (const line of fs.readFileSync(tx, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const msg = ev?.message;
      const content = msg?.content;
      // Scan the user's TYPED text (string, or text blocks — not tool_result) for corrections.
      if (msg?.role === "user") {
        const userText = typeof content === "string" ? content
          : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text || "").join(" ") : "";
        if (CORRECTION_RE.test(userText)) corrected = true;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type !== "tool_use") continue;
        const n = b.name || "";
        if (/project-memory__(log_issue|append_decision|append_learning|resolve_issue)/.test(n)) captured = true;
        if (/project-memory__remember_preference/.test(n)) { captured = true; prefSaved = true; }
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) {
          didWork = true;
          // Direct edits to the memory files ARE capture (this repo's blessed path), not just MCP-tool calls.
          if (/(^|\/)(AGENTS\.md|issues\.jsonl)$/.test(b.input?.file_path || "")) { captured = true; prefSaved = true; }
        }
        if (n === "Bash" && /git\s+commit/.test(b.input?.command || "")) didWork = true;
      }
    }
  }
  const needWorkCapture = didWork && !captured;     // code changed, nothing saved
  const needPrefCapture = corrected && !prefSaved;  // user corrected how you work, no preference saved
  if (!needWorkCapture && !needPrefCapture) allow(); // nothing changed/corrected, or already recorded → no nag

  const parts = ["Before ending this session:"];
  if (needWorkCapture) parts.push("code changed but nothing was saved to project memory — if a future session should know it, call log_issue (a non-trivial bug + its fix), append_decision (a real/architectural choice + WHY), or append_learning (a durable gotcha).");
  if (needPrefCapture) parts.push("the user corrected how you work — if it's a durable preference/habit (style, workflow, a 'from now on' rule), call remember_preference (scope 'global' for a cross-project habit, else 'project') so it's recalled and applied next time instead of being corrected again.");
  parts.push("Then report in one line what you saved. If genuinely nothing is worth saving, say so briefly and stop.");
  process.stdout.write(JSON.stringify({ decision: "block", reason: parts.join(" ") }) + "\n");
  process.exit(0);
}

// `... recall` — UserPromptSubmit-hook entrypoint for OPT-IN "auto-recall". Claude Code runs
// this when you submit a prompt and pipes the prompt on stdin; we keyword-match it against the
// issue history + decisions/learnings/preferences and inject the strongest hits as context, so
// prior fixes/decisions surface WITHOUT anyone remembering to search. Silent (exit 0, no output)
// when nothing is relevant. PROJECT_MEMORY_RECALL=off is a per-session kill switch.
if (process.argv[2] === "recall") {
  if (process.env.PROJECT_MEMORY_RECALL === "off") process.exit(0);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
  const prompt = (data.prompt || "").trim();
  if (!prompt) process.exit(0);

  // Which project are we in? (cwd inside ROOT/<project>) — current-project hits rank higher.
  let current = null;
  try { const rel = path.relative(ROOT, data.cwd || ""); if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) current = rel.split(path.sep)[0]; } catch {}

  // All candidate memory items across projects (issue + decision/learning/preference bullets).
  const items = [];
  for (const p of listProjectDirs()) for (const it of memoryItems(p)) items.push({ ...it, project: p });
  if (!items.length) process.exit(0);

  const emb = await getEmbedder();
  let hits = [];
  if (emb) {
    // SEMANTIC path — cosine similarity between the prompt and each item, so paraphrases
    // match ("build broke" ↔ "compile failure") even with no shared words. Vectors come from
    // the per-project cache; only cache misses (new/edited items) are embedded, then persisted.
    const qv = await embed(prompt);
    const caches = {}, dirty = {};
    for (const it of items) {
      const c = caches[it.project] ||= readEmbCache(it.project);
      const key = hashText(it.body);
      if (!c[key]) { c[key] = await embed(it.body); dirty[it.project] = true; }
      it.vec = c[key];
    }
    for (const p in dirty) writeEmbCache(p, caches[p]);
    for (const it of items) {
      if (!it.vec) continue;
      const s = cosine(qv, it.vec);
      const thr = it.project === current ? 0.25 : 0.35; // current project surfaces on weaker matches
      if (s >= thr) hits.push({ ...it, score: s + (it.project === current ? 0.05 : 0) });
    }
  } else {
    // KEYWORD fallback (no embeddings model available) — literal substring hits. Generic
    // English + dev-filler words carry no signal (nearly every issue has "error"/"fix"/"code"),
    // so drop them; here the stopword set stands in for a similarity threshold.
    const STOP = new Set("the and for with this that from have what when where which your you are was can has not but get set use why how who will into out off should would could please help need want make made does did done file files code line lines error errors issue issues bug bugs fix fixes fixed run running test tests function add added new using used work works working change changes about there their then them they here have just like more some only also into your".split(/\s+/));
    const words = [...new Set(prompt.toLowerCase().match(/[a-z0-9_]{4,}/g) || [])].filter((w) => !STOP.has(w));
    if (!words.length) process.exit(0);
    const score = (hay) => { const h = hay.toLowerCase(); let s = 0; for (const w of words) if (h.includes(w)) s++; return s; };
    const keep = (s, p) => s >= 2 || (s >= 1 && p === current); // cross-project needs 2 keyword hits; current project 1
    for (const it of items) {
      const s = score(it.body);
      if (keep(s, it.project)) hits.push({ ...it, score: s + (it.project === current ? 1 : 0) });
    }
  }
  if (!hits.length) process.exit(0);
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 4).map((h) => `• ${h.kind === "issue" ? "" : h.kind + " "}${h.project !== current ? `(${h.project}) ` : ""}${h.text}`);
  const ctx = `🧠 project-memory — possibly relevant to this request (you may have solved or decided this before; call search_issues / find_by_file / get_project for full detail before re-solving):\n${top.join("\n")}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } }) + "\n");
  process.exit(0);
}

// `... reindex` — warm the semantic caches ahead of time so the first recall after new
// memory isn't slow. Embeds every not-yet-cached item across all projects and persists the
// vectors. No-op-ish if the embeddings model isn't installed (prints how to get it). Run it
// after a big logging session, or once after enabling recall.
if (process.argv[2] === "reindex") {
  const emb = await getEmbedder();
  if (!emb) {
    console.error(`Semantic recall needs the embeddings model. Install it in this folder:\n  npm i @xenova/transformers\n(Recall still works without it via keyword fallback.)`);
    process.exit(1);
  }
  let total = 0;
  for (const p of listProjectDirs()) {
    const cache = readEmbCache(p);
    const items = memoryItems(p);
    let added = 0;
    for (const it of items) {
      const key = hashText(it.body);
      if (!cache[key]) { cache[key] = await embed(it.body); added++; }
    }
    if (added) writeEmbCache(p, cache);
    total += added;
    console.log(`  ${p}: +${added} vector(s) (${items.length} items).`);
  }
  console.log(`Reindexed ${total} new item(s) with ${EMBED_MODEL}.`);
  process.exit(0);
}

// `... install-hook|uninstall-hook` (Stop = guaranteed-capture) and
// `... install-recall|uninstall-recall` (UserPromptSubmit = auto-recall) — register/remove the
// respective hook in ~/.claude/settings.json. Both OPT-IN: plain `install` adds NEITHER.
if (["install-hook", "uninstall-hook", "install-recall", "uninstall-recall"].includes(process.argv[2])) {
  const removing = process.argv[2].startsWith("uninstall");
  const isRecall = process.argv[2].endsWith("recall");
  const event = isRecall ? "UserPromptSubmit" : "Stop";
  const sub = isRecall ? "recall" : "hook";
  const settingsPath = path.join(process.env.HOME || ".", ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  // Stable absolute path when installed from source; fall back to npx from the cache.
  const fromCache = /[/\\](_npx|\.npm|node_modules)[/\\]/.test(HERE);
  const command = fromCache ? `npx -y ${PKG} ${sub}` : `node "${path.join(HERE, "index.js")}" ${sub}`;
  const isOurs = (g) => (g?.hooks || []).some((x) => new RegExp(`project-memory.*${sub}\\b|index\\.js" ${sub}\\b`).test(x.command || ""));
  cfg.hooks = cfg.hooks || {};
  cfg.hooks[event] = (cfg.hooks[event] || []).filter((g) => !isOurs(g)); // drop any prior copy (idempotent)
  if (!removing) cfg.hooks[event].push({ matcher: "*", hooks: [{ type: "command", command, timeout: isRecall ? 10 : 30 }] });
  if (!cfg.hooks[event].length) delete cfg.hooks[event];
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
  const what = isRecall ? "auto-recall (UserPromptSubmit)" : "guaranteed-capture (Stop)";
  const off = isRecall ? "PROJECT_MEMORY_RECALL=off" : "PROJECT_MEMORY_HOOK=off";
  console.log(removing
    ? `Removed project-memory ${what} hook from ${settingsPath}.`
    : `Installed project-memory ${what} hook in ${settingsPath}:\n  ${command}\nON. Restart Claude Code. Per-session off: ${off} · remove: ${process.argv[2].replace("install", "uninstall")}.`);
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
- After the user corrects how you work, or states a durable preference (code style, workflow habit, a "from now on" rule), call remember_preference — scope "global" for a cross-project habit, "project" for one project. Preferences ride the auto-loaded AGENTS.md, so they come back next session and turn a one-time correction into a remembered pattern.
Always tell the user in one short line what you recorded. When unsure whether something is worth storing, ASK rather than logging noise. Skip trivial/transient issues. Never store secrets or credentials.`;

const server = new McpServer({ name: "project-memory", version: "1.8.0" }, { instructions: INSTRUCTIONS });

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

server.registerTool("remember_preference",
  { title: "Remember a preference", description: "Append a dated bullet under '## Preferences' in an AGENTS.md (auto-loaded memory), turning a user correction or stated habit into a remembered pattern that comes back next session. Call this PROACTIVELY when the user corrects HOW you work or states a durable preference — code style, workflow habit, a 'from now on' rule (e.g. 'never add a co-author trailer', 'always run the typecheck before committing') — don't wait to be asked, then tell the user in one line what you saved. Use scope 'global' (root AGENTS.md, applies to EVERY project) for a cross-project habit; scope 'project' for a preference about one project. This is about agent behaviour/preferences; for a project DECISION use append_decision, for a bug use log_issue.", inputSchema: {
      text: z.string().describe("The preference as a durable rule, ideally with a short WHY. Phrase it as guidance for next time, not a one-off."),
      scope: z.enum(["global", "project"]).optional().describe("'global' = root AGENTS.md (every project). 'project' = one project. Defaults to global, unless only a project is given."),
      project: z.string().optional().describe("Required when scope is 'project'."),
  } },
  async ({ text: t, scope, project }) => {
    const useGlobal = scope === "global" || (!scope && !project);
    if (useGlobal) {
      const file = rootAgentsPath();
      if (!fs.existsSync(file)) return err(`No root AGENTS.md at ${file} to hold global preferences.`);
      appendBulletToFile(file, "Preferences", `- ${today()}: ${t}`);
      return text(`Recorded GLOBAL preference in root AGENTS.md (applies to every project).`);
    }
    if (!project) return err(`scope "project" needs a project name.`);
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}".`);
    appendUnderHeading(project, "Preferences", `- ${today()}: ${t}`);
    return text(`Recorded preference in ${project}/AGENTS.md.`);
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
