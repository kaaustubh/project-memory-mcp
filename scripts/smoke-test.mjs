import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
const scratchRoot = mkdtempSync(join(tmpdir(), "project-memory-smoke-"));
const PROJECT = "demo-project";

const EXPECTED_TOOLS = [
  "list_projects", "get_project", "search_memory", "append_decision",
  "append_learning", "remember_preference", "log_issue", "search_issues",
  "list_open_issues", "resolve_issue", "sync_registry", "find_by_file",
  "start_initiative", "get_initiative", "list_initiatives", "update_initiative",
  "check_in", "check_out",
];

// A minimal project so the initiative tools (which require an existing AGENTS.md) have
// something to work against.
mkdirSync(join(scratchRoot, PROJECT), { recursive: true });
writeFileSync(join(scratchRoot, PROJECT, "AGENTS.md"), "# demo-project\n\n## What this is\nSmoke test fixture.\n");

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const child = spawn(process.execPath, [indexPath], {
    env: { ...process.env, PROJECT_MEMORY_ROOT: scratchRoot },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const responses = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  const exitPromise = new Promise((resolve) => child.on("exit", resolve));

  const waitFor = async (id) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = responses.find((x) => x.id === id);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`timed out waiting for response id ${id}`);
  };

  let nextId = 2;
  const call = async (name, args) => {
    const id = ++nextId;
    send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await waitFor(id);
    if (r.error) throw new Error(`tools/call ${name} error: ${JSON.stringify(r.error)}`);
    if (r.result?.isError) throw new Error(`tools/call ${name} returned isError: ${JSON.stringify(r.result)}`);
    return r.result?.content?.[0]?.text ?? "";
  };

  send(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-test", version: "0.0.0" } },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });

  const initResp = await waitFor(1);
  const listResp = await waitFor(2);

  if (!initResp?.result?.serverInfo?.name) {
    throw new Error(`initialize failed: ${JSON.stringify(initResp)}`);
  }
  const names = (listResp?.result?.tools ?? []).map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    throw new Error(`tools/list missing expected tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
  }

  // --- exercise the initiatives lifecycle end-to-end over tools/call ---
  const agentsPath = join(scratchRoot, PROJECT, "AGENTS.md");
  const readAgents = () => readFileSync(agentsPath, "utf8");

  await call("start_initiative", {
    project: PROJECT, codename: "HashGate",
    plan: "Roll out the new hashing scheme.",
    todos: ["migrate table", "backfill data"],
  });
  assert(readAgents().includes("Active Initiatives"), "AGENTS.md should gain an Active Initiatives section");
  assert(readAgents().includes("initiatives/hash-gate.md"), "AGENTS.md should point at initiatives/hash-gate.md");

  // fuzzy/case-insensitive lookup should resolve to the same initiative
  const fetched = await call("get_initiative", { project: PROJECT, codename: "hash gate" });
  assert(fetched.includes("- [ ] migrate table"), "fetched initiative should list its todos unchecked");

  await call("update_initiative", {
    project: PROJECT, codename: "HashGate",
    progress: "migrated the table",
    complete_todos: ["migrate table"],
  });
  const afterUpdate = await call("get_initiative", { project: PROJECT, codename: "HashGate" });
  assert(afterUpdate.includes("- [x] migrate table"), "completed todo should be checked off");
  assert(afterUpdate.includes("- [ ] backfill data"), "untouched todo should remain unchecked");
  assert(afterUpdate.includes("migrated the table"), "progress log should include the new line");

  const listed = await call("list_initiatives", { project: PROJECT });
  assert(listed.includes("HashGate"), "list_initiatives should surface the active initiative");

  await call("update_initiative", { project: PROJECT, codename: "HashGate", status: "done" });
  assert(!readAgents().includes("initiatives/hash-gate.md"), "AGENTS.md pointer should be removed once done");

  const listedDone = await call("list_initiatives", { project: PROJECT, status: "done" });
  assert(listedDone.includes("HashGate"), "list_initiatives(status:done) should still find the completed initiative");

  // --- exercise the worklog lifecycle: check_in → log work → two-pass check_out → standup CLI ---
  const ci = await call("check_in", {});
  assert(ci.includes("Checked in"), "check_in should confirm the check-in");
  await call("log_issue", { project: PROJECT, symptom: "smoke worklog issue", fix: "n/a" });
  const co1 = await call("check_out", {});
  assert(co1.includes("Evidence harvested"), "first check_out should return harvested evidence");
  assert(co1.includes("smoke worklog issue"), "harvest should include the issue logged today");
  assert(co1.includes("call check_out again"), "first check_out should instruct the two-pass summary call");
  const co2 = await call("check_out", { summary: "- did smoke-test things" });
  assert(co2.includes("standup summary recorded"), "second check_out should store the summary");

  child.kill();
  await exitPromise;

  const st = spawnSync(process.execPath, [indexPath, "standup"], {
    env: { ...process.env, PROJECT_MEMORY_ROOT: scratchRoot }, encoding: "utf8",
  });
  assert(st.status === 0, `standup subcommand should exit 0 (stderr: ${st.stderr})`);
  assert(st.stdout.includes("did smoke-test things"), "standup subcommand should print the recorded summary");

  rmSync(scratchRoot, { recursive: true, force: true });

  console.log(`OK: server initialized as "${initResp.result.serverInfo.name}" v${initResp.result.serverInfo.version}, ${names.length} tools registered, initiatives + worklog lifecycles verified end-to-end.`);
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
