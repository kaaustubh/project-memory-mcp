import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
const scratchRoot = mkdtempSync(join(tmpdir(), "project-memory-smoke-"));

const EXPECTED_TOOLS = [
  "list_projects", "get_project", "search_memory", "append_decision",
  "append_learning", "remember_preference", "log_issue", "search_issues",
  "list_open_issues", "resolve_issue", "sync_registry", "find_by_file",
];

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
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

  send(child, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-test", version: "0.0.0" } },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });

  const deadline = Date.now() + 10_000;
  while (responses.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  child.kill();
  await exitPromise;
  rmSync(scratchRoot, { recursive: true, force: true });

  const initResp = responses.find((r) => r.id === 1);
  const listResp = responses.find((r) => r.id === 2);

  if (!initResp?.result?.serverInfo?.name) {
    throw new Error(`initialize failed: ${JSON.stringify(initResp)}`);
  }
  const names = (listResp?.result?.tools ?? []).map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    throw new Error(`tools/list missing expected tools: ${missing.join(", ")} (got: ${names.join(", ")})`);
  }

  console.log(`OK: server initialized as "${initResp.result.serverInfo.name}" v${initResp.result.serverInfo.version}, ${names.length} tools registered.`);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
