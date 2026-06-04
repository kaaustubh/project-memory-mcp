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
