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

const server = new McpServer({ name: "project-memory", version: "1.0.0" });

// ----------------------------- project memory (AGENTS.md) -----------------------------

server.registerTool("list_projects",
  { title: "List projects", description: "List all projects under ~/code that have an AGENTS.md memory file.", inputSchema: {} },
  async () => {
    const projects = listProjectDirs();
    if (!projects.length) return text("No projects with AGENTS.md found under " + ROOT);
    const rows = projects.map((p) => {
      const body = fs.readFileSync(agentsPath(p), "utf8");
      const m = body.match(/##\s+What this is\s*\n+([^\n]+)/i);
      const open = readIssues(p).filter((i) => i.status !== "resolved").length;
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
  { title: "Append a decision", description: "Append a dated bullet under '## Decisions' in a project's AGENTS.md (auto-loaded memory). For concise, durable decisions — NOT bugs.", inputSchema: { project: z.string(), text: z.string().describe("One line: the decision and WHY, not just what.") } },
  async ({ project, text: t }) => {
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}".`);
    appendUnderHeading(project, "Decisions", `- ${today()}: ${t}`);
    return text(`Recorded decision in ${project}/AGENTS.md.`);
  });

server.registerTool("append_learning",
  { title: "Append a learning", description: "Append a dated bullet under '## Learnings' in a project's AGENTS.md (auto-loaded memory). For durable gotchas/workarounds — for a specific bug use log_issue instead.", inputSchema: { project: z.string(), text: z.string() } },
  async ({ project, text: t }) => {
    if (!projectExists(project)) return err(`No AGENTS.md for "${project}".`);
    appendUnderHeading(project, "Learnings", `- ${today()}: ${t}`);
    return text(`Recorded learning in ${project}/AGENTS.md.`);
  });

// ----------------------------- issue log (issues.jsonl, NOT auto-loaded) -----------------------------

server.registerTool("log_issue",
  { title: "Log a bug/issue", description: "Append a structured bug/issue to <project>/issues.jsonl (high-volume memory, NOT auto-loaded). Captures every problem faced during development.", inputSchema: {
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
  { title: "Search issues", description: "Search bug/issue history across all projects (or one). Use this to answer 'have we hit this before?'.", inputSchema: { query: z.string(), project: z.string().optional() } },
  async ({ query, project }) => {
    const q = query.toLowerCase();
    const scope = project ? [project] : listProjectDirs();
    const hits = [];
    for (const p of scope) {
      for (const e of readIssues(p)) {
        if (JSON.stringify(e).toLowerCase().includes(q)) hits.push({ project: p, ...e });
      }
    }
    if (!hits.length) return text(`No issues match "${query}".`);
    return text(hits.map((h) => `[${h.id}] (${h.status}) ${h.symptom}${h.fix ? ` — fix: ${h.fix}` : ""}`).join("\n"));
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

await server.connect(new StdioServerTransport());
