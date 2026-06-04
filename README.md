# project-memory MCP server

A small, local [MCP](https://modelcontextprotocol.io) server that gives AI agents
(Claude Code, Cursor, …) a shared, persistent memory of the projects in a code folder —
what each project is, decisions made, and **every bug/issue faced during development.**

It is **stateless**: every tool reads/writes plain files on disk, so multiple clients
(and multiple machines) share one source of truth.

## The model

| Layer | Lives in | Auto-loaded into context? | For |
|---|---|---|---|
| Project memory | `<project>/AGENTS.md` | ✅ yes (via `CLAUDE.md` → `@AGENTS.md`) | identity, stack, run cmds, concise decisions/learnings — **keep lean** |
| Issue log | `<project>/issues.jsonl` | ❌ no | high-volume bug/issue history — fetched on demand |

**Design rule:** durable, low-volume facts go in `AGENTS.md` (auto-loaded). High-volume
history (bugs) goes in `issues.jsonl` (queried via `search_issues`). This keeps the
always-loaded context small while keeping everything searchable.

## Tools

- `list_projects`, `get_project`, `search_memory` — read project memory
- `append_decision`, `append_learning` — append a dated bullet to `AGENTS.md`
- `log_issue` — record a bug/problem → `issues.jsonl`
- `search_issues` — "have we hit this before?" across all projects
- `list_open_issues`, `resolve_issue` — track / close bugs

## Install (npm — recommended)

From your code/projects folder, run:

```bash
cd ~/code            # the folder that holds your projects
npx -y @kaaustubh/project-memory-mcp install
```

That registers the server with Claude Code (user scope) and Cursor, using the current
directory as your projects root. Restart those apps, then ask your agent
*"set up project memory for this folder"* to scaffold `AGENTS.md` for each project.

> No clone, no global install — the MCP config just runs `npx`, which fetches and runs
> the latest version on demand.

### From source instead

```bash
git clone https://github.com/kaaustubh/project-memory-mcp.git ~/code/.memory-server
cd ~/code/.memory-server && ./install.sh
```

## How it works (after install)

A common question: *"once I install it, does it just start doing things?"* Not quite —
the server is **passive**. Here's the actual flow:

1. **Restart your editor.** MCP servers are loaded at startup, so the server only
   becomes available the next time you launch Claude Code / Cursor.
2. **Push layer (automatic, not the server):** when you open a project, the editor reads
   `AGENTS.md` (via `CLAUDE.md` → `@AGENTS.md`) into the model's context for you. This is
   why the agent "just knows" what your project is — it's a built-in editor feature.
3. **Pull layer (the server, on request):** the server announces its tools and then
   waits. It does nothing on its own. The agent calls a tool only when it's relevant —
   e.g. you say *"log this bug"* or *"have we hit this before?"*, or the model decides a
   tool is useful. There's no background process or scanning.

> **Day one is empty.** A fresh setup has no `AGENTS.md` files yet, so the auto-load has
> nothing to load and `log_issue` will refuse until a project's memory exists. Bootstrap
> once by asking your agent: *"set up project memory for this folder"* — it creates the
> `AGENTS.md` files. After that, everything works.

In short: **a convention (auto-loaded files) + a tool the agent chooses to use + a
one-time setup.** No magic, no daemon.

## Across machines

The **tool** and your **memory content** sync separately:

1. **Tool:** nothing to sync — `npx` always pulls the published version (or `git pull`
   if you installed from source).
2. **Content:** each project's `AGENTS.md` + `issues.jsonl` live inside that project's
   own git repo, so cloning your projects brings their memory along. Nothing to copy.

> `issues.jsonl` holds real bug details — only commit it into **private** repos.

## New-project scaffold

For a new project under the root, create `<project>/CLAUDE.md` containing `@AGENTS.md`
and a `<project>/AGENTS.md` with `## What this is`, `## Stack & layout`,
`## Run / build / test`, `## Decisions`, `## Learnings` sections.
