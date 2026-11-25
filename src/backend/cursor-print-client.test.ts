import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CursorPrintClient, cursorPrintRequested } from "./cursor-print-client";
import { type AppServerNotification, isRecord } from "./protocol";

const INIT = `{"type":"system","subtype":"init","cwd":"/tmp","session_id":"session-1","model":"Claude Opus 5.5 300K Medium","permissionMode":"default"}`;
const PARTIAL_ONE = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"One\\nTwo"}]},"session_id":"session-1"}`;
const PARTIAL_TWO = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"\\nThree"}]},"session_id":"session-1"}`;
const REPEATED_FULL = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"One\\nTwo\\nThree"}]},"session_id":"session-1"}`;
const TOOL_STARTED = `{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"echo hi","toolCallId":"call-1"},"description":"Echo hi"},"toolCallId":"call-1"}}`;
const TOOL_COMPLETED = `{"type":"tool_call","subtype":"completed","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"echo hi","toolCallId":"call-1"},"result":{"success":{"command":"echo hi","exitCode":0,"stdout":"hi\\n"}}},"toolCallId":"call-1"}}`;
const RESULT = `{"type":"result","subtype":"success","is_error":false,"result":"One\\nTwo\\nThree","session_id":"session-1","request_id":"request-1","usage":{"inputTokens":6,"outputTokens":176,"cacheReadTokens":28974,"cacheWriteTokens":9903}}`;
const FAILED = `{"type":"result","subtype":"error","is_error":true,"result":"Cursor is not signed in","session_id":"session-1","request_id":"request-2"}`;

function fakeEnvRuntime(): string {
  const directory = mkdtempSync(join(tmpdir(), "cursor-print-env-"));
  const path = join(directory, "cursor-agent");
  writeFileSync(
    path,
    `#!/bin/sh\ncat > /dev/null\nprintf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]},"session_id":"session-1"}\\n' "$CURSOR_CONFIG_DIR"\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"session-1","request_id":"request-3"}\\n'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeRuntime(...lines: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "cursor-print-"));
  const path = join(directory, "cursor-agent");
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\n${lines.map((line) => `printf '%s\\n' '${line}'`).join("\n")}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function runTurn(
  script: string,
  prompt = "Count.",
): Promise<{ notifications: AppServerNotification[]; diagnostics: string[] }> {
  const client = new CursorPrintClient({ executable: script, version: "test" }, { cwd: () => tmpdir() });
  const notifications: AppServerNotification[] = [];
  const diagnostics: string[] = [];
  client.on("notification", (notification) => notifications.push(notification));
  client.on("diagnostic", (text) => diagnostics.push(text));
  client.start();
  const completed = new Promise<void>((resolve) => {
    client.on("notification", (notification) => {
      if (notification.method === "turn/completed") resolve();
    });
  });
  await Effect.runPromise(client.request("thread/start", { threadId: "thread-1" }, (value) => value));
  await Effect.runPromise(
    client.request("turn/start", { threadId: "thread-1", input: [{ type: "text", text: prompt }] }, (value) => value),
  );
  await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await Effect.runPromise(client.stop());
  return { notifications, diagnostics };
}

function stringParam(value: unknown, key: string): string {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === "string" ? found : "";
}

function isToolItem(notification: AppServerNotification): boolean {
  const item = isRecord(notification.params) ? notification.params.item : undefined;
  return isRecord(item) && item.type === "toolCall";
}

function deltas(notifications: AppServerNotification[]): string {
  return notifications
    .filter((notification) => notification.method === "item/agentMessage/delta")
    .map((notification) => stringParam(notification.params, "delta"))
    .join("");
}

describe("cursor print client", () => {
  it("is off unless the environment asks for it", () => {
    expect(cursorPrintRequested({})).toBe(false);
    expect(cursorPrintRequested({ OPENBOT_CURSOR_PRINT: "0" })).toBe(false);
    expect(cursorPrintRequested({ OPENBOT_CURSOR_PRINT: "1" })).toBe(true);
  });

  it("turns repeated partial records into the answer once, and reports the runtime's tokens unchanged", async () => {
    const { notifications } = await runTurn(fakeRuntime(INIT, PARTIAL_ONE, PARTIAL_TWO, REPEATED_FULL, RESULT));
    expect(notifications[0]).toMatchObject({ method: "turn/started" });
    expect(deltas(notifications)).toBe("One\nTwo\nThree");
    expect(
      notifications.filter((notification) => notification.method === "item/completed").map((n) => n.params),
    ).toContainEqual({
      threadId: "thread-1",
      turnId: expect.any(String),
      item: { id: expect.any(String), type: "agentMessage", phase: "final_answer", text: "One\nTwo\nThree" },
    });
    const usage = notifications.find((notification) => notification.method === "openbot/usage");
    expect(usage?.params).toMatchObject({
      threadId: "thread-1",
      promptId: "request-1",
      requestId: "request-1",
      sessionId: "session-1",
      source: { provider: "cursor", runtime: "cursor-agent" },
      usage: { inputTokens: 6, outputTokens: 176, cacheReadTokens: 28974, cacheWriteTokens: 9903 },
    });
    expect(notifications.at(-1)).toMatchObject({ method: "turn/completed", params: { turn: { status: "completed" } } });
  });

  it("reports a failed runtime result as a failed turn with its message", async () => {
    const { notifications, diagnostics } = await runTurn(fakeRuntime(INIT, FAILED));
    expect(diagnostics).toContain("Cursor is not signed in");
    expect(notifications.at(-1)).toMatchObject({ method: "turn/completed", params: { turn: { status: "failed" } } });
    expect(notifications.some((notification) => notification.method === "openbot/usage")).toBe(false);
  });

  it("reports a shell call as a tool item that starts and then completes", async () => {
    const { notifications } = await runTurn(fakeRuntime(INIT, TOOL_STARTED, TOOL_COMPLETED, RESULT));
    const tool = notifications.filter(isToolItem);
    expect(tool.map((notification) => notification.method)).toEqual(["item/started", "item/completed"]);
    expect(tool[0]?.params).toMatchObject({ item: { name: "echo hi", toolKind: "execute", status: "inProgress" } });
    expect(tool[1]?.params).toMatchObject({ item: { status: "completed", result: "hi\n" } });
  });

  it("spawns the confined target and gives it the confined environment", async () => {
    const client = new CursorPrintClient(
      { executable: "/nonexistent/would-not-run", version: "test" },
      {
        cwd: () => tmpdir(),
        confine: () => ({ command: fakeEnvRuntime(), args: [], windowsVerbatimArguments: false }),
        confinedEnv: () => ({ CURSOR_CONFIG_DIR: "/confined/config" }),
      },
    );
    const notifications: AppServerNotification[] = [];
    client.on("notification", (notification) => notifications.push(notification));
    client.start();
    const completed = new Promise<void>((resolve) => {
      client.on("notification", (notification) => {
        if (notification.method === "turn/completed") resolve();
      });
    });
    await Effect.runPromise(client.request("thread/start", { threadId: "thread-1" }, (value) => value));
    await Effect.runPromise(
      client.request("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "go" }] }, (value) => value),
    );
    await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await Effect.runPromise(client.stop());
    expect(deltas(notifications)).toBe("/confined/config");
  });

  it("refuses to pretend it compacted a thread", async () => {
    const client = new CursorPrintClient({ executable: "/nonexistent", version: "test" }, {});
    client.start();
    await expect(
      Effect.runPromise(client.request("thread/compact/start", { threadId: "t" }, (value) => value)),
    ).rejects.toBeTruthy();
    await Effect.runPromise(client.stop());
  });

  it("says it cannot steer a running turn", async () => {
    const client = new CursorPrintClient({ executable: "/nonexistent", version: "test" }, {});
    client.start();
    await Effect.runPromise(client.request("thread/start", { threadId: "thread-1" }, (value) => value));
    await expect(
      Effect.runPromise(client.request("turn/steer", { threadId: "thread-1" }, (value) => value)),
    ).rejects.toBeTruthy();
    await Effect.runPromise(client.stop());
  });
});
