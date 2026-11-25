import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { CursorPrintClient } from "../src/backend/cursor-print-client";
import { type AppServerNotification, getRecord, getString } from "../src/backend/protocol";

const REPORT_PATH = ".openbot-build/cursor-print-cwd-e2e.json";

type TurnResult = { case: string; workspace: string | null; status: string; printed: string };

function fakeRuntime(): string {
  const directory = mkdtempSync(join(tmpdir(), "cursor-print-cwd-"));
  const path = join(directory, "cursor-agent");
  writeFileSync(
    path,
    `#!/bin/sh\ncat > /dev/null\nprintf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]},"session_id":"cwd-session"}\\n' "$PWD"\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"cwd-session","request_id":"cwd-request","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}\\n'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function runTurn(threadParams: { cwd?: string }): Promise<{ status: string; printed: string }> {
  const client = new CursorPrintClient({ executable: fakeRuntime(), version: "e2e" }, {});
  const notifications: AppServerNotification[] = [];
  client.on("notification", (notification) => notifications.push(notification));
  client.start();
  const completed = new Promise<void>((resolve) => {
    client.on("notification", (notification) => {
      if (notification.method === "turn/completed") resolve();
    });
  });
  await Effect.runPromise(client.request("thread/start", { threadId: "thread-1", ...threadParams }, (value) => value));
  await Effect.runPromise(
    client.request(
      "turn/start",
      { threadId: "thread-1", input: [{ type: "text", text: "where am I" }] },
      (value) => value,
    ),
  );
  await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  await Effect.runPromise(client.stop());
  let printed = "";
  for (const notification of notifications) {
    if (notification.method !== "item/agentMessage/delta") continue;
    printed += getString(notification.params, "delta") ?? "";
  }
  const completedTurn = notifications.find((notification) => notification.method === "turn/completed");
  const status = getString(getRecord(completedTurn?.params ?? null, "turn"), "status") ?? "unknown";
  return { status, printed };
}

const results: TurnResult[] = [];
const report: { result: "pass" | "fail"; turns: TurnResult[]; failure?: string } = { result: "fail", turns: results };
const workspace = mkdtempSync(join(tmpdir(), "openbot-workspace-"));
try {
  const inside = await runTurn({ cwd: workspace });
  results.push({ case: "thread workspace", workspace, status: inside.status, printed: inside.printed });
  assert.equal(inside.status, "completed", "a thread with a workspace should run");
  assert.equal(inside.printed, workspace, "the runtime must start in the thread workspace");

  const refused = await runTurn({});
  results.push({ case: "no workspace", workspace: null, status: refused.status, printed: refused.printed });
  assert.equal(refused.status, "failed", "a thread with no workspace must not run a turn");
  assert.equal(refused.printed, "", "a refused turn must not run the runtime");

  report.result = "pass";
  mkdirSync(".openbot-build", { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`cursor-print-cwd-e2e: pass, ${results.length} cases, ${REPORT_PATH}\n`);
} catch (failure) {
  report.failure = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
  mkdirSync(".openbot-build", { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`cursor-print-cwd-e2e: fail, ${String(report.failure)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
