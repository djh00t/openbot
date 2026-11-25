import { describe, expect, it } from "vitest";
import {
  cursorToolOutput,
  cursorToolTitle,
  cursorTurnUsage,
  cursorUsagePayload,
  parseCursorStreamLine,
} from "./cursor-stream";

const INIT = `{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/acpprobe/work","session_id":"307f0fd7-7f9d-4d49-9e2e-f7dda50820d4","model":"Claude Opus 5.5 300K Medium","permissionMode":"default"}`;

const RESULT = `{"type":"result","subtype":"success","duration_ms":6758,"duration_api_ms":6758,"is_error":false,"result":"\`alpha.txt\` has one line","session_id":"307f0fd7-7f9d-4d49-9e2e-f7dda50820d4","request_id":"0bd40115-1936-4e46-8444-6dea45ef197e","usage":{"inputTokens":6,"outputTokens":176,"cacheReadTokens":28974,"cacheWriteTokens":9903}}`;

const SHELL_STARTED = `{"type":"tool_call","subtype":"started","call_id":"toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv","tool_call":{"shellToolCall":{"args":{"command":"echo hi","workingDirectory":"","timeout":30000,"toolCallId":"toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv"},"description":"Echo hi"},"toolCallId":"toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv","startedAtMs":"1795587204146"},"model_call_id":"0bd40115-1936-4e46-8444-6dea45ef197e-0-31rh","session_id":"307f0fd7-7f9d-4d49-9e2e-f7dda50820d4"}`;

const SHELL_COMPLETED = `{"type":"tool_call","subtype":"completed","call_id":"toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv","tool_call":{"shellToolCall":{"args":{"command":"echo hi","toolCallId":"toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv"},"result":{"success":{"command":"echo hi","exitCode":0,"stdout":"hi\\n","stderr":"","interleavedOutput":"hi\\n"}}},"toolCallId":"toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv","completedAtMs":"1795587204313"},"session_id":"307f0fd7-7f9d-4d49-9e2e-f7dda50820d4"}`;

const READ_COMPLETED = `{"type":"tool_call","subtype":"completed","call_id":"toolu_bdrk_01CQp1jMF1fk8jYdjCiu44T8","tool_call":{"readToolCall":{"args":{"path":"/tmp/acpprobe/work/alpha.txt"},"result":{"success":{"content":"alpha contents: A1\\n","totalLines":2,"path":"/tmp/acpprobe/work/alpha.txt"}}},"toolCallId":"toolu_bdrk_01CQp1jMF1fk8jYdjCiu44T8"},"session_id":"307f0fd7-7f9d-4d49-9e2e-f7dda50820d4"}`;

const ASSERTION_FAILED = `{"type":"result","subtype":"error","is_error":true,"result":"Cursor is not signed in","session_id":"307f0fd7-7f9d-4d49-9e2e-f7dda50820d4","request_id":"aaa"}`;

describe("cursor stream records", () => {
  it("reads the session, model and cwd from the init record", () => {
    expect(parseCursorStreamLine(INIT)).toEqual({
      kind: "init",
      sessionId: "307f0fd7-7f9d-4d49-9e2e-f7dda50820d4",
      model: "Claude Opus 5.5 300K Medium",
      cwd: "/tmp/acpprobe/work",
    });
  });

  it("reports the exact token numbers the runtime printed for a real turn", () => {
    const record = parseCursorStreamLine(RESULT);
    expect(record).toMatchObject({
      kind: "result",
      sessionId: "307f0fd7-7f9d-4d49-9e2e-f7dda50820d4",
      requestId: "0bd40115-1936-4e46-8444-6dea45ef197e",
      failed: false,
      usage: { inputTokens: 6, outputTokens: 176, cacheReadTokens: 28974, cacheWriteTokens: 9903 },
    });
  });

  it("reports a failed result with its message", () => {
    expect(parseCursorStreamLine(ASSERTION_FAILED)).toMatchObject({
      kind: "result",
      failed: true,
      error: "Cursor is not signed in",
      usage: null,
    });
  });

  it("separates a shell call's started and completed records", () => {
    expect(parseCursorStreamLine(SHELL_STARTED)).toMatchObject({
      kind: "tool",
      phase: "started",
      tool: "execute",
      callId: "toolu_bdrk_0126a9qCG9Aw2R3MBekAugNv",
      args: { command: "echo hi" },
      error: null,
    });
    const completed = parseCursorStreamLine(SHELL_COMPLETED);
    expect(completed).toMatchObject({ kind: "tool", phase: "completed", tool: "execute" });
    if (completed?.kind !== "tool") throw new Error("expected a tool record");
    expect(cursorToolTitle(completed)).toBe("echo hi");
    expect(cursorToolOutput(completed)).toBe("hi\n");
  });

  it("reads a file read's content back out of the completed call", () => {
    const record = parseCursorStreamLine(READ_COMPLETED);
    if (record?.kind !== "tool") throw new Error("expected a tool record");
    expect(record.tool).toBe("read");
    expect(cursorToolTitle(record)).toBe("/tmp/acpprobe/work/alpha.txt");
    expect(cursorToolOutput(record)).toBe("alpha contents: A1\n");
  });

  it("joins an assistant message's text blocks", () => {
    const line = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first "},{"type":"text","text":"second"}]},"session_id":"s"}`;
    expect(parseCursorStreamLine(line)).toEqual({ kind: "assistant", text: "first second" });
  });

  it("ignores records it has no use for and malformed lines", () => {
    expect(parseCursorStreamLine(`{"type":"user","message":{}}`)).toEqual({ kind: "ignored", type: "user" });
    expect(parseCursorStreamLine("not json")).toBeNull();
    expect(parseCursorStreamLine("")).toBeNull();
    expect(parseCursorStreamLine("[]")).toBeNull();
  });

  it("keeps a usage record only when the runtime reported numbers", () => {
    expect(cursorTurnUsage({ inputTokens: 4, outputTokens: 7 })).toEqual({
      inputTokens: 4,
      outputTokens: 7,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
    expect(cursorTurnUsage({})).toBeNull();
    expect(cursorTurnUsage(undefined)).toBeNull();
    expect(cursorTurnUsage({ inputTokens: -1, outputTokens: 1.5 })).toBeNull();
  });

  it("hands the collection path a total input so cache reads are not counted twice", () => {
    const usage = cursorTurnUsage(JSON.parse(RESULT).usage);
    expect(usage).not.toBeNull();
    if (!usage) throw new Error("expected usage");
    expect(cursorUsagePayload(usage)).toEqual({
      inputTokens: 6 + 28974 + 9903,
      outputTokens: 176,
      cachedReadTokens: 28974,
      cachedWriteTokens: 9903,
    });
  });

  it("claims no uncached input when the runtime did not report it", () => {
    const payload = cursorUsagePayload({
      inputTokens: null,
      outputTokens: 12,
      cacheReadTokens: 9664,
      cacheWriteTokens: 9565,
    });
    expect(payload.inputTokens).toBeNull();
    expect(payload).toMatchObject({ cachedReadTokens: 9664, cachedWriteTokens: 9565, outputTokens: 12 });
  });

  it("sums only the parts the runtime reported", () => {
    expect(
      cursorUsagePayload({ inputTokens: 4, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: null }),
    ).toMatchObject({ inputTokens: 104, cachedWriteTokens: null });
    expect(
      cursorUsagePayload({ inputTokens: 4, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null }),
    ).toMatchObject({ inputTokens: 4 });
  });
});
