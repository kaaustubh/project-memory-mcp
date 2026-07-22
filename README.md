# project-memory MCP server

A small, local [MCP](https://modelcontextprotocol.io) server that gives AI agents
(Claude Code, Cursor, VS Code / GitHub Copilot, …) a shared, persistent memory of the projects in a code folder —
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

### Works even where MCP is locked down

Some orgs disable third-party MCP servers via policy (e.g. GitHub Copilot's
[MCP allowlist enforcement](https://docs.github.com/en/copilot/reference/mcp-allowlist-enforcement)).
Because the memory is **plain files, not a service**, the core value survives that:

- **The memory itself is just files.** `AGENTS.md` is auto-loaded by the editor reading it —
  no MCP call involved — so a project's identity, decisions, learnings, and preferences still
  land in the agent's context.
- **The policy is Copilot-scoped and per-client.** It doesn't affect the same server in
  Claude Code or Cursor, and orgs running *allowlist / registry-only* mode can permit it —
  this server is published to the official MCP Registry (`io.github.kaaustubh/project-memory-mcp`).

Only the interactive **tools** (`log_issue`, `search_issues`, …) go over the MCP channel; the
file-based memory keeps working without it.

## Tools

- `list_projects`, `get_project`, `search_memory` — read project memory
- `append_decision`, `append_learning` — append a dated bullet to `AGENTS.md`
- `remember_preference` — turn a correction / stated habit into a remembered pattern (`## Preferences` in the root `AGENTS.md` for a global habit, or a project's for a local one); rides the auto-load, so it comes back next session
- `log_issue` — record a bug/problem → `issues.jsonl`
- `search_issues` — "have we hit this before?" across all projects (field-scoped; optional `tags` filter)
- `list_open_issues`, `resolve_issue` — track / close bugs
- `sync_registry` — reconcile the root `AGENTS.md` projects table with what's on disk (adds rows for new projects, flags stale ones)
- `find_by_file` — given a file path, surface the issues + decisions/learnings that touch it ("why is this code like this?")

> You don't call these directly — you talk to your agent in natural language and it picks
> the tool. See **Using it day to day** below for what to actually say.

## Using it day to day

Most of it runs itself: opening a project auto-loads its `AGENTS.md` (the agent already
knows the project), and capture is proactive (plus the optional Stop hook). Your job is
mainly to **pull** memory at the right moments. Just talk to your agent:

| When | Say something like | What fires |
|---|---|---|
| **Before debugging anything** | *"Have we hit this before? `<paste error>`"* | `search_issues` across all projects |
| **Starting something you've done elsewhere** | *"How did I do Stripe webhook verification in any project?"* | `search_memory` (cross-project) |
| **Landing on confusing code** | *"Why is `index.js` like this? Check the memory."* | `find_by_file` |
| **You made a real decision / fixed a real bug** | *(nothing — it logs on its own and tells you)* | `append_decision` / `log_issue` |
| **You correct how the agent works** | *"No, always run the typecheck before committing — remember that."* | `remember_preference` (global or per-project) |
| **Triage** | *"What's still open across my projects?"* | `list_open_issues` |
| **A bug is fixed** | *"Resolve pulse_stripe-004 — fixed by …"* | `resolve_issue` |
| **Added a new project** | *"Sync the registry."* | `sync_registry` |

**The one habit that matters:** make *"have we hit this before?"* reflexive before every
debugging session. That's where a memory tool earns its keep; the rest the system handles.

**Capture is confirming, not silent** — when the agent logs something it tells you in one
line. Correct it freely: *"don't log that"*, or *"actually, log this too."*

**Escape hatches:** `PROJECT_MEMORY_HOOK=off` silences the Stop hook for one session;
`uninstall-hook` removes it entirely.

## Install (npm — recommended)

From your code/projects folder, run:

```bash
cd ~/code            # the folder that holds your projects
npx -y @kaaustubh/project-memory-mcp install
```

That registers the server, using the current directory as your projects root, with every
client that has an MCP config location on this machine:

| Client | Config written |
|---|---|
| Claude Code | user scope, via `claude mcp add` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code / GitHub Copilot Chat | user-profile `mcp.json` (applies to every workspace) |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` (or `$COPILOT_HOME`) |
| JetBrains Copilot plugin (IntelliJ, PyCharm, WebStorm, …) | `~/.config/github-copilot/intellij/mcp.json` |
| Visual Studio (Windows) | `%USERPROFILE%\.mcp.json` — global, all solutions |

Each write merges into the existing file (other MCP servers you've already configured are
left alone) and is independently best-effort — a client that isn't installed on this
machine is silently skipped, the rest still get registered. Restart whichever app(s) you
use, then ask your agent *"set up project memory for this folder"* to scaffold `AGENTS.md`
for each project.

> **Copilot surfaces (VS Code, CLI, JetBrains, Visual Studio):** tools only run in
> **Agent mode**, and config changes need a restart to take effect.

> No clone, no global install — the MCP config just runs `npx`, which fetches and runs
> the latest version on demand.

> **Team memory (beta signup):** want this memory shared across your team instead of
> just your machine? Register your interest: https://github.com/kaaustubh/project-memory-mcp/issues/1

### From source instead

```bash
git clone https://github.com/kaaustubh/project-memory-mcp.git ~/code/.memory-server
cd ~/code/.memory-server && ./install.sh
```

## How it works (after install)

A common question: *"once I install it, does it just start doing things?"* Not quite —
the server is **passive**. Here's the actual flow:

1. **Restart your editor.** MCP servers are loaded at startup, so the server only
   becomes available the next time you launch Claude Code / Cursor / VS Code.
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

## Proactive capture (you don't have to say "log this")

The server ships a standing **capture policy** (sent to the client on connect, plus
directive tool descriptions), so the agent records things on its own instead of waiting
for you to ask:

- Before debugging a reported error → it checks `search_issues` for a prior fix.
- After fixing a non-trivial bug → it calls `log_issue`.
- After a real decision or a durable gotcha → `append_decision` / `append_learning`.
- After you correct how it works or state a habit → `remember_preference`, so the one-time correction becomes a pattern it brings back next session.

It's **proactive but not silent**: the agent tells you in one line what it recorded, asks
when unsure rather than logging noise, and skips trivia and secrets. You can always
override — "log this", or "don't bother". The standing policy is best-effort (it depends
on the model following it); for a hard guarantee, add the opt-in Stop hook below.

## Guaranteed capture (opt-in Stop hook)

The standing policy can be forgotten mid-session. The **Stop hook** makes capture
non-optional: when the agent tries to end a turn, it runs once and blocks the stop to ask
for one capture pass when either (a) real work happened (file edits or a commit) and
**nothing** was written to project memory, or (b) you **corrected how it works** and no
preference was saved. If memory was already written, or nothing changed and you didn't
correct it, the hook stays silent and lets the turn end.

```bash
npx -y @kaaustubh/project-memory-mcp install-hook    # turn it on (then restart Claude Code)
npx -y @kaaustubh/project-memory-mcp uninstall-hook  # turn it off
```

- **Off by default** — plain `install` does not add it; you enable it explicitly.
- **No loops** — it fires at most once per turn (guarded by `stop_hook_active`), then lets
  the agent stop.
- **Per-session kill switch** — set `PROJECT_MEMORY_HOOK=off` to disable without uninstalling.
- **Cost** — it adds one extra model turn only on sessions that changed code but logged
  nothing, or where you corrected the agent and no preference was saved; silent otherwise.

## Automatic recall (opt-in UserPromptSubmit hook)

Capture is only half the loop — the other half is *remembering to look*. The **recall hook**
closes it: every time you submit a prompt, it matches your request against your issue
history and decisions/learnings/preferences, and silently injects the strongest hits as
context. So a prior fix or decision surfaces **without you (or the agent) remembering to
search** — the "have we hit this before?" habit becomes automatic.

```bash
npx -y @kaaustubh/project-memory-mcp install-recall    # turn it on (then restart Claude Code)
npx -y @kaaustubh/project-memory-mcp uninstall-recall   # turn it off
```

- **Semantic matching (when available)** — if the optional embeddings model
  (`@xenova/transformers`) is installed, recall matches by **meaning**, so *"the build is
  broken"* still surfaces an issue logged as *"compile failure"* even with no shared words.
  Runs fully offline (the model is fetched once, then cached). Without it, recall falls back
  to keyword matching automatically — no configuration, nothing breaks.
- **Silent unless relevant** — injects nothing for trivial prompts or when there's no match.
- **Ranked & capped** — current-project hits rank highest; at most 4 lines are injected.
- **Off by default** — like the Stop hook, it's opt-in (per-prompt cost). Plain `install` adds
  neither hook.
- **Per-session kill switch** — set `PROJECT_MEMORY_RECALL=off` to disable without uninstalling.

> **Warm the cache:** after a big logging session (or once, after enabling recall) run
> `npx -y @kaaustubh/project-memory-mcp reindex` to pre-embed everything, so the first recall
> isn't the one that pays for it. Vectors are cached per project in a derived
> `.embeddings.json` (safe to delete / git-ignore — the `.jsonl` + `AGENTS.md` stay the
> source of truth).

> Pair it with the Stop hook and the loop runs itself: the Stop hook guarantees things get
> *saved*, the recall hook guarantees they come *back* at the right moment.

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

## Changelog

### v1.8.0
- **Feature:** `install` now also registers **GitHub Copilot CLI** (`~/.copilot/mcp-config.json`,
  or `$COPILOT_HOME`), the **JetBrains Copilot plugin** (IntelliJ/PyCharm/WebStorm/…), and
  **Visual Studio** on Windows (global `.mcp.json`) — rounding out every Copilot surface
  alongside the VS Code registration added in 1.7.0. Each target merges into its existing
  config (other servers are preserved) and is independently best-effort, so a client that
  isn't installed is silently skipped rather than failing the whole install. Schemas differ
  per client (`mcpServers` vs `servers` top-level key; `type: "local"` for the Copilot CLI
  vs `type: "stdio"` for the IDE-embedded ones) — verified against each client's current
  docs before implementing. The merge logic for all five targets was consolidated into one
  `registerMcp()` helper.

### v1.7.0
- **Feature:** `install` now also registers the server with **VS Code / GitHub Copilot**
  (user-profile `mcp.json`, so it applies to every workspace), alongside the existing
  Claude Code and Cursor registration. Schema differs from Claude/Cursor (`servers` key,
  `type: "stdio"` per entry) and Copilot tools only run in Chat's Agent mode.

### v1.6.2
- **Docs:** added a team-memory beta signup note (README install section + the `install`
  subcommand's console output) — https://github.com/kaaustubh/project-memory-mcp/issues/1

### v1.6.1
- **Docs:** added "Works even where MCP is locked down" — clarifies that the file-based memory
  (`AGENTS.md` auto-load) keeps working even where an org disables third-party MCP servers
  (e.g. GitHub Copilot's MCP allowlist), since only the interactive tools use the MCP channel.

### v1.6.0
- **Semantic recall (optional local embeddings).** The recall hook now matches your prompt
  against memory by *meaning*, not shared substrings — *"the build is broken"* surfaces an
  issue logged as *"compile failure"*. Powered by a local, offline embedding model
  (`Xenova/all-MiniLM-L6-v2` via the optional `@xenova/transformers` dependency); vectors are
  cached per project in a derived `.embeddings.json`, keyed by content hash so edited/removed
  items self-invalidate. If the model isn't installed it **falls back to the previous keyword
  matching automatically** — nothing to configure, nothing breaks. New `reindex` subcommand
  pre-embeds all memory so the first recall isn't slow. This completes the long-deferred
  "semantic retrieval" lever behind both recall and `search_issues`; keyword remains the
  zero-dependency floor.

### v1.5.0
- **Automatic recall (opt-in `UserPromptSubmit` hook).** New `install-recall` / `uninstall-recall`
  subcommands register a hook that keyword-matches every prompt against your issue history and
  decisions/learnings/preferences and silently injects the strongest hits as context — so prior
  fixes and decisions surface without anyone remembering to search. Closes the other half of the
  capture↔recall loop. Silent on trivial/no-match prompts (generic filler words ignored),
  current-project hits ranked highest, at most 4 lines injected. Off by default; per-session kill
  switch `PROJECT_MEMORY_RECALL=off`.

### v1.4.1
- Packaging: add the `mcpName` field (`io.github.kaaustubh/project-memory-mcp`) required to list
  the server in the official MCP Registry. No functional change.

### v1.4.0
- **`remember_preference` — corrections become remembered patterns.** New tool that writes a
  dated bullet under `## Preferences`, either in the **root** `AGENTS.md` (scope `global` —
  applies to every project) or a single project's. Because preferences live in the
  auto-loaded `AGENTS.md`, recall is free: a one-time correction ("never add a co-author
  trailer", "always typecheck before committing") comes back next session and is applied
  instead of re-corrected. Closes the cross-session loop for *how you like to work*, not just
  project facts.
- **Correction-aware Stop hook + capture policy.** The standing policy now nudges
  `remember_preference` after a correction, and the opt-in Stop hook scans the session for
  behavioural-correction phrases ("from now on…", "no, don't…", "always use…"): if you
  corrected the agent and no preference was saved, it blocks the stop once to ask — a second,
  independent reason alongside the existing "code changed but nothing logged" check.

### v1.3.2
- Docs: added a **"Using it day to day"** section — the natural-language prompts that map to
  each tool, the one habit that matters ("have we hit this before?"), and the escape
  hatches. Clarifies that you talk to the agent rather than calling tools directly.

### v1.3.1
- **Stop hook: count direct memory edits as capture.** The hook previously recognized only
  `mcp__project-memory__*` tool calls, so editing `AGENTS.md` / `issues.jsonl` directly
  (an endorsed capture path) still triggered the nag. It now also treats an `Edit`/`Write`
  to a file ending in `AGENTS.md` or `issues.jsonl` as captured — eliminating the false
  positive.
- **`append_decision`/`append_learning`: no more duplicate sections.** Heading matching was
  whole-line (`^## Learnings$`), so a heading with trailing text (`## Learnings (gotchas …)`)
  wasn't found and a duplicate section got appended. Now matches the heading's leading word.

### v1.3.0
- **Guaranteed capture (opt-in Stop hook).** New `install-hook` / `uninstall-hook`
  subcommands register a Claude Code `Stop` hook that forces a single capture pass when a
  session changed code but recorded nothing to memory — turning the best-effort policy into
  a hard guarantee. Off by default, fires at most once per turn (no loops), silent when
  nothing changed or memory was already written, and disablable per-session via
  `PROJECT_MEMORY_HOOK=off`.

### v1.2.0
- **Sharper issue search.** `search_issues` now matches only the text fields
  (symptom/cause/fix/id/tags) instead of the raw JSON, so queries no longer get false hits
  on field names. Added an optional `tags` filter; `query` is now optional (search by tags
  alone).
- **`sync_registry`.** Reconciles the root `AGENTS.md` projects table with the projects on
  disk — adds stub rows for projects missing from the table, flags rows whose directory is
  gone, and reports live open-issue counts. Automates the previously manual "new project →
  add a row" step. Hand-curated columns are preserved; `apply=false` reports drift only.
- **`find_by_file`.** Given a file path/fragment, returns the issues (via their `files`
  field) and the decisions/learnings (via AGENTS.md bullets that mention it) touching that
  file — code↔memory linking for "why is this code the way it is?".

### v1.1.1
- Docs only: publishes the changelog to the npm page for parity (no functional change).

### v1.1.0
- **Proactive capture.** The agent now records memory on its own instead of waiting for
  "log this": a standing capture policy is sent on `initialize` and the write/search tool
  descriptions are directive. It stays confirming (tells you what it logged), asks when
  unsure, and skips trivia/secrets. Explicit calls still work as an override.
- Docs: added "How it works (after install)" and "Proactive capture" sections.

### v1.0.1
- Fix `npx … install` failing with "command not found" — the bin is renamed to
  `project-memory-mcp` to match the unscoped package name (npx resolution rule).

### v1.0.0
- Initial release: stateless MCP server over `AGENTS.md` + `issues.jsonl`, 9 tools
  (project memory + issue tracking), `npx … install` for Claude Code and Cursor, and the
  push/pull memory model.
