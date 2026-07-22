# project-memory-mcp — Agent Memory

> This is the tool's own dev memory. It is auto-loaded when you open this repo in an
> editor, but it is NOT shipped to npm (the `files` whitelist excludes it). Note: the
> server **excludes itself** from project discovery (`.memory-server` is dotfile- and
> SKIP-filtered in `index.js`), so this project won't appear in `list_projects` or an
> all-projects `search_issues` — it's first-class only via the editor auto-load here.

## What this is
A small local **MCP server** that gives AI coding agents (Claude Code, Cursor, any MCP
client) a shared, persistent memory of a folder of projects: what each project is, key
decisions, and every bug/issue faced during development.

- npm: `@kaaustubh/project-memory-mcp` · repo: github.com/kaaustubh/project-memory-mcp
- All logic lives in a single file: `index.js` (~210 lines).

## Architecture (the core ideas)
- **Protocol:** MCP = JSON-RPC 2.0 over **stdio**. The client spawns this script as a
  subprocess and exchanges newline-delimited JSON messages (`initialize` →
  `notifications/initialized` → `tools/list` → `tools/call`).
- **Stateless:** every tool reads/writes plain files on disk and returns; nothing is held
  in memory between calls. Consequence: multiple clients (and machines) sharing the same
  files share one memory. **The filesystem is the source of truth.**
- **Two-layer memory (push vs pull):**
  - *Push* — `<project>/AGENTS.md` is auto-loaded into the model's context by the editor
    (via `CLAUDE.md` → `@AGENTS.md`), NOT by this server. Low-volume, durable: identity,
    decisions, learnings. Keep lean.
  - *Pull* — `<project>/issues.jsonl` is NOT auto-loaded; high-volume bug history fetched
    on demand via `search_issues`. Keeps always-loaded context small but searchable.
- **Discovery is the filesystem, not a registry** (`listProjectDirs`): scan `ROOT` for
  subdirs containing `AGENTS.md`. Can't drift.

## Stack & layout
- Node.js ESM (`"type": "module"`), Node >= 18.
- Deps: `@modelcontextprotocol/sdk` (high-level `McpServer` + `StdioServerTransport`),
  `zod` (tool input schemas).
- `index.js` — server + all 12 tools + the `install` subcommand (gated on `argv[2]`).
- `install.sh` — install path for the from-source (git clone) install.
- `README.md` — public docs (this is what shows on npmjs.com).
- `ROOT` = `PROJECT_MEMORY_ROOT` env, else parent dir of the script.

## Run / build / test
- Run the server directly: `node index.js` (then speak JSON-RPC on stdin).
- Register locally: `./install.sh`. Register via npm: `npx -y @kaaustubh/project-memory-mcp install`.
- **Testing pattern:** spawn the process and drive it over stdio — send `initialize`,
  then the `notifications/initialized` notification, then `tools/call`. (See git history
  for the smoke-test scripts.) Read each stdout line as one JSON-RPC message.
- **Test `install` safely:** set `HOME=/tmp/...` and `PROJECT_MEMORY_ROOT=/tmp/...` so it
  writes to a throwaway config instead of your real `~/.claude.json` / `~/.cursor/mcp.json`.
- **Release:** bump `version` in BOTH `package.json` and the `McpServer({version})` string
  in `index.js`, commit, `npm publish`. `npx -y` users auto-get the latest (unpinned).
- **Subcommands** (gated on `argv[2]`, all short-circuit before `server.connect`): `install`
  (register MCP server), `install-hook` / `uninstall-hook` (opt-in Stop hook = guaranteed
  capture), `hook` (Stop-hook entrypoint — reads the Stop payload on stdin via
  `fs.readFileSync(0)`, decides allow vs. block), `install-recall` / `uninstall-recall` (opt-in
  UserPromptSubmit hook = auto-recall), `recall` (UserPromptSubmit entrypoint — keyword-matches
  the prompt against memory and injects hits via `hookSpecificOutput.additionalContext`). The two
  installers share one generalized block keyed on the event (Stop vs UserPromptSubmit).

## Decisions
- 2026-06-04: Store content in `AGENTS.md` with a one-line `CLAUDE.md` (`@AGENTS.md`) stub — AGENTS.md is the cross-tool standard (Cursor/Codex read it), CLAUDE.md bridges it for Claude Code.
- 2026-06-04: Split memory push/pull — durable facts auto-load via AGENTS.md, high-volume bugs stay out of context in issues.jsonl. This is the main token/clarity lever; the server is secondary to this design rule.
- 2026-06-04: Keep the server stateless over plain files so clients/machines share one source of truth and the data stays git-versioned, greppable, and tool-agnostic.
- 2026-06-04: Discover projects by scanning the filesystem (dirs with AGENTS.md) instead of a registry, so it never drifts.
- 2026-06-04: `PROJECT_MEMORY_ROOT` env (fallback to parent dir) for portability — required for the npx case where the script lives in npm's cache.
- 2026-06-04: No file lock — single-user, serialized usage assumed; concurrent writes are out of scope by choice.
- 2026-06-04: Distribute via npm/npx with an `install` subcommand; scoped name `@kaaustubh/project-memory-mcp` because the bare `project-memory-mcp` was published-then-unpublished and is registry-reserved.
- 2026-06-04: Make capture proactive (agent self-evaluates) via the MCP server `instructions` field + directive tool descriptions, rather than requiring the user to say "log this" each time. Kept it confirming-not-silent (agent reports what it logged, asks when unsure) to avoid noise/wrong-memory. A deterministic `Stop` hook for guaranteed capture was deliberately left out (per-session cost; opt-in v2).
- 2026-06-05 (v1.2.0): `search_issues` now matches text fields (symptom/cause/fix/id/tags) instead of `JSON.stringify(entry)` — kills false hits on JSON keys (searching "fix" no longer matches every resolved row). Chose field-scoping over embeddings to stay zero-dep/offline/stateless; `query` made optional + added `tags` filter. Pure-substring embeddings remain the deferred bigger lever.
- 2026-06-05 (v1.2.0): Added `sync_registry` to reconcile the root projects table with on-disk dirs — additive only (adds stub rows for new projects, FLAGS stale rows but never deletes, preserves hand-curated Stack/Status/descriptions). Non-destructive by choice because the table is hand-curated and richer than project `## What this is`; `apply=false` for report-only. Automates step 4 of the root update protocol (the one manual step that actually drifts).
- 2026-06-05 (v1.2.0): Added `find_by_file` (code↔memory linking) — finally reads the long-unused `files` field on issues, plus matches Decisions/Learnings bullets that mention a path. Answers "why is this code like this?" from memory.
- 2026-06-05 (v1.3.0): Shipped the previously-deferred guaranteed-capture Stop hook, but as a SEPARATE concern from the MCP server: it's a `hook` subcommand of index.js, registered via `install-hook` into `~/.claude/settings.json`, NOT part of the server's tool surface. Kept OFF by default (plain `install` doesn't add it) because of the per-session cost called out when it was deferred. The hook is a gate, not the capturer — it blocks the stop ONCE (guarded by `stop_hook_active`) and only when work happened (Edit/Write/commit) with no project-memory write; the model still does the actual logging. So "guaranteed" = guaranteed to be ASKED, not silently auto-logged (keeps the confirming-not-silent principle).
- 2026-06-05 (v1.3.0): Hook command uses absolute `node <abspath>/index.js hook` for source installs, falling back to `npx -y PKG hook` when running from an npm/npx cache (detected via `_npx`/`.npm`/`node_modules` in the script path) — mirrors the server registration's npx approach and avoids baking a volatile cache path into settings.json.
- 2026-06-08 (v1.4.0): Added `remember_preference` (corrections/habits → a `## Preferences` section) to close the cross-session loop for *how the user works*, not just project facts. Chose to reuse the auto-loaded AGENTS.md rather than build relevance-triggered recall: global prefs go in the ROOT AGENTS.md (auto-loaded for every project), project prefs in the project's — so recall is FREE for always-apply rules, no embeddings needed. Default scope is global when neither scope nor project is given (a bare "remember this" is usually a cross-project habit). Generalized `appendUnderHeading`→`appendBulletToFile(file,…)` so it can target the root file, not only a project. Task-relevance/semantic recall (surfacing situational prefs on a "similar task") deliberately deferred — that's the bigger embeddings lever; this release only does the always-on (push) half.
- 2026-06-08 (v1.4.0): Made the Stop hook correction-aware as a SECOND, independent block reason (alongside "code changed, nothing logged"): it scans the user's TYPED text (string or `type:"text"` blocks only — never tool_result, to avoid matching tool output) for behavioural-correction phrases (`CORRECTION_RE`) and blocks once if corrected && no preference saved. Kept the regex moderately specific to avoid nagging on every "no"; `stop_hook_active` + the per-session kill switch still bound it. This is the one case where the hook can fire with NO code changes (a pure-conversation correction is exactly what we want to capture).
- 2026-07-03 (v1.6.0): Shipped the long-deferred SEMANTIC recall (embeddings), but as a strictly OPTIONAL, drop-in upgrade to the existing recall hook — NOT a rewrite. `@xenova/transformers` (local `all-MiniLM-L6-v2`, offline after 1st fetch) is an **optionalDependency**, and `getEmbedder()` is wrapped in try/catch so a missing/broken model transparently FALLS BACK to the original keyword scorer (kept verbatim in the `else` branch). Chose optionalDependencies over a hard dep to protect the lean/zero-friction base install (npx still works if onnx won't build on a platform); over documenting a manual `npm i` because the feature should just work when recall is enabled. Vectors cached per project in a DERIVED `.embeddings.json` (keyed by content hash → edited/removed items self-invalidate; safe to delete/gitignore, `.jsonl`+AGENTS.md stay source of truth) — preserves stateless/files-as-truth. Only cache misses embed, so steady-state cost is embedding just the prompt. New `reindex` subcommand pre-warms caches. With real cosine scores the stopword kludge becomes unnecessary on the semantic path (a low-signal prompt just fails the threshold) — kept it only in the keyword fallback. Verified end-to-end: a paraphrase with zero shared keywords ("payment provider callback rejecting requests as forged") surfaced a Stripe-webhook-signature issue that keyword recall could not reach.
- 2026-07-22 (v1.7.0): `install` now also registers **VS Code / GitHub Copilot**, alongside Claude Code and Cursor — user asked "can we not provision this to make it work with Copilot too?" after a Slack-draft reframe surfaced that their team uses Copilot, not Claude Code/Cursor. Wrote to the user-profile `mcp.json` (not workspace `.vscode/mcp.json`) so one `install` run covers every workspace, matching how Claude/Cursor registration is already user/global-scoped. Path differs by OS (`~/Library/Application Support/Code/User/mcp.json` on macOS, `%APPDATA%/Code/User/mcp.json` on Windows, `~/.config/Code/User/mcp.json` on Linux) and the schema differs from Claude/Cursor (`servers` key not `mcpServers`, each entry needs `"type": "stdio"`) — verified against VS Code's MCP docs before implementing, since Copilot's MCP support (GA'd in VS Code 1.102, July 2025) was outside training-data knowledge. Wrapped the write in try/catch (non-fatal) so a missing/unwritable VS Code user dir doesn't break Claude/Cursor registration. Verified merge-not-clobber behavior (pre-existing `servers` entries survive a second `install` run) via a throwaway-HOME test before committing, per this repo's own testing convention.

## Learnings (gotchas — read before changing packaging)
- 2026-06-04: **npx runs the command matching the UNSCOPED package name.** Bin must be named `project-memory-mcp` (not `project-memory`), or `npx @kaaustubh/project-memory-mcp install` fails with `sh: project-memory: command not found`. Fixed in 1.0.1.
- 2026-06-04: **Publishing with passkey/WebAuthn 2FA:** `--otp` does NOT apply (no TOTP code). Use `npm login --auth-type=web` (browser passkey) then `npm publish`, or a granular access token with "bypass 2FA". A 403 "Two-factor authentication required" means auth + scope are fine — it's just the 2FA gate.
- 2026-06-04: **Don't test packaging with `npx ./pkg.tgz`** — npx tries to exec the tarball path and fails with "Permission denied". Instead `npm install` the tarball into a temp consumer project, then invoke the bin by name.
- 2026-06-04: **Self-exclusion:** `.memory-server` is filtered out by the dotfile check and the `SKIP` set, so the tool doesn't track itself in `list_projects`/all-project search. Direct `get_project`/`log_issue` by name still work (they use the path, not the filtered list).
- 2026-06-04: Keep the `McpServer` version string in sync with `package.json` on each release (it's reported to the client; easy to forget).
- 2026-06-04: **Release convention** — ANY user-facing change must: bump semver (patch=fix/docs, minor=feature), add a `## Changelog` entry in README, sync the `McpServer` version string, commit, `npm publish`, and tag `vX.Y.Z` + push tags. Docs-only changes still get a patch release so the npm page stays in parity (npm won't re-render the README without a new version).
- 2026-06-05: **Subcommands must read stdin SYNCHRONOUSLY** (`fs.readFileSync(0)`), not via async `process.stdin` handlers. The whole file runs top-to-bottom to `await server.connect(...)`; an async stdin handler returns immediately and the code falls through to ALSO start the MCP server. Synchronous read blocks until EOF, then `process.exit(0)` — no fall-through. (Affects the `hook` subcommand.)
- 2026-06-05 (found by dogfooding, fixed in 1.3.1): **`appendUnderHeading` matched headings with an exact-line regex** (`^## Learnings$`), so a heading with trailing text like `## Learnings (gotchas …)` wasn't found and a DUPLICATE `## Learnings` section got appended at EOF. Fixed to match the heading's leading word (`^##\s+Learnings\b`). Lesson: section headings in the wild carry parentheticals — match by prefix, not whole line.
- 2026-06-05 (found by dogfooding, fixed in 1.3.1): **Stop hook only counted `mcp__project-memory__*` calls as capture**, so editing AGENTS.md/issues.jsonl directly (this repo's normal path) still tripped the nag. Fixed: an Edit/Write to a file ending in AGENTS.md or issues.jsonl now counts as captured.
- 2026-06-10 (v1.5.0): Auto-recall is a `UserPromptSubmit` hook (`recall` subcommand), NOT an MCP tool — it has to fire on every prompt and inject context, which only a hook can do. Verified the contract first: inject via `{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext}}` on exit 0 (plain stdout also works, but the JSON form is explicit); exit 2 would REJECT/erase the prompt, so we never use it. Kept OPT-IN like the Stop hook (per-prompt cost) and silent-by-default. Noise control without embeddings: a stopword set drops generic dev filler ("error/fix/bug/code") so single common words don't fire it; cross-project hits need ≥2 keyword matches, current-project ≥1; cap 4 lines. This is the keyword (zero-dep) half of the long-deferred relevance-triggered recall; semantic/embeddings remains the future lever.
- 2026-06-10 (v1.5.0): Generalized the hook installer into ONE block keyed on event/sub (Stop↔`hook`, UserPromptSubmit↔`recall`) instead of duplicating. `isOurs` matches per-sub (`project-memory.*${sub}\b|index\.js" ${sub}\b`) so `uninstall-recall` removes only the UserPromptSubmit entry and `uninstall-hook` only the Stop entry — they coexist and don't clobber each other (verified). Recall timeout 10s (it runs on every prompt; must not stall input), Stop stays 30s.
- 2026-06-10: **Official MCP Registry publishing** (now listed as `io.github.kaaustubh/project-memory-mcp`): flow is (1) add `mcpName` to package.json matching the `io.github.<user>/...` namespace + `name` in `server.json`, (2) `npm publish` FIRST (registry only stores metadata and validates the npm package carries `mcpName`), (3) `brew install mcp-publisher` → `mcp-publisher login github` (device code) → `mcp-publisher publish`. `server.json` is repo-only (kept OUT of the `files` whitelist so it doesn't bloat the npm tarball). Gotcha: `server.json` **`description` must be ≤ 100 chars** or publish 422s (`expected length <= 100`) — npm's description can be longer, the registry's can't. Fixing only server.json metadata needs NO npm republish — just re-run `mcp-publisher publish`.

- 2026-07-03 (v1.6.0): **Semantic recall makes the `recall` subcommand ASYNC** — it uses top-level `await getEmbedder()` / `await embed()`. This is safe ONLY because each subcommand block ends in `process.exit()` (so it never falls through to `await server.connect`), and the model is loaded via **dynamic `import("@xenova/transformers")`**, NOT a static top-of-file import — a static import would drag the (heavy onnxruntime) model loader into EVERY invocation, including the MCP server and every other subcommand. Keep it a lazy dynamic import guarded by try/catch. Also: `search_issues`/`search_memory` are deliberately left keyword-only (still sync, zero-dep); only the recall hook + `reindex` opted into embeddings so far.
- 2026-07-12: **`PROJECT_MEMORY_ROOT` in `~/.claude.json` (`mcpServers.project-memory.env`) got misset to `/Users/dev/code/.memory-server` instead of `/Users/dev/code`** — the server was scanning its own repo folder for project subdirs, found none, so every `append_decision`/`append_learning`/`list_projects` call silently came back empty (surfaced as "No AGENTS.md for '<project>'" on a project, e.g. vecto, that clearly has one). No error was thrown — a wrong root just looks like an empty/missing registry, not a crash. Fixed by editing that one env value back to `/Users/dev/code` (back up `~/.claude.json` first — it's global, shared config). **Because the server is a stdio subprocess spawned once at session start, the fix doesn't take effect until the session restarts** (new session, or an MCP reconnect) — checking `list_projects` in the same session that just patched the config will still show the stale root. Lesson: if `list_projects`/append tools report a project missing that you know has an `AGENTS.md`, check `PROJECT_MEMORY_ROOT` in `~/.claude.json` before assuming a code bug.

## Known sharp edges (candidates for future work)
- v1.6.0 landed SEMANTIC recall (optional local embeddings) — the long-deferred lever, now done for the recall hook + `reindex`. Still keyword-only: `search_issues` and `search_memory` (the interactive MCP tools). Extending them to semantic is the obvious next step (embed()/cosine() + the per-project cache already exist; each tool handler is async so it can `await embed()`), left out only to keep this release scoped to the auto-recall path.
- The `.embeddings.json` cache is written INTO each project's own repo dir — add it to that repo's `.gitignore` (or the server could relocate caches under a single dot-dir) to avoid dirtying `git status` across projects.
- Auto-recall inherits the self-exclusion: working IN `.memory-server`, `listProjectDirs()` skips it, so the hook surfaces only OTHER projects' memory, never this repo's own.
- Issue IDs are `lineCount+1` — can collide if a line is deleted or on concurrent writes.
- `resolve_issue` rewrites the whole file (only non-append op).
- No delete tool by design (append-only history); prune via manual file edit.
- `ROOT` is a single flat folder — nested/monorepo project layouts aren't discovered.
- The tool doesn't dogfood its own pull layer (see self-exclusion above). Truly
  first-class self-tracking would need a discovery tweak (e.g. allow a folder that has an
  explicit `AGENTS.md` even if dotfile/SKIP).

## Preferences
- 2026-07-12: Never add a "Co-Authored-By: Claude..." trailer to git commits, ever — user explicitly opted out. Enforced at the config level via `attribution.commit: ""` in ~/.claude/settings.json, not just agent memory.
- 2026-07-10: Always research/verify current facts (pricing, tier limits, product availability) via web search before presenting options as choices, rather than relying on training-data knowledge — it can be stale and wrong (e.g. incorrectly called Fly.io's tier "generous free" when it dropped its free hobby tier in 2024).
