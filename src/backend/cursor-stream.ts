import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { getRecord, getString, isRecord } from "./protocol";

export type CursorToolKind = "read" | "edit" | "execute" | "fetch" | "search" | "task" | "other";

export type CursorTurnUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
};

export type CursorStreamRecord =
  | { readonly kind: "init"; readonly sessionId: string; readonly model: string | null; readonly cwd: string | null }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly phase: "started" | "completed";
      readonly callId: string;
      readonly tool: CursorToolKind;
      readonly args: DynamicRecord | null;
      readonly result: DynamicRecord | null;
      readonly error: string | null;
    }
  | {
      readonly kind: "result";
      readonly sessionId: string | null;
      readonly requestId: string | null;
      readonly usage: CursorTurnUsage | null;
      readonly failed: boolean;
      readonly error: string | null;
    }
  | { readonly kind: "ignored"; readonly type: string };

const TOOL_KINDS: readonly [string, CursorToolKind][] = [
  ["readToolCall", "read"],
  ["writeToolCall", "edit"],
  ["editToolCall", "edit"],
  ["deleteToolCall", "edit"],
  ["shellToolCall", "execute"],
  ["fetchToolCall", "fetch"],
  ["webSearchToolCall", "search"],
  ["searchToolCall", "search"],
  ["grepToolCall", "search"],
  ["globToolCall", "search"],
  ["taskToolCall", "task"],
  ["mcpToolCall", "other"],
];

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function cursorTurnUsage(value: unknown): CursorTurnUsage | null {
  const usage = getRecord(value, "usage") ?? (isRecord(value) ? value : null);
  if (!usage) return null;
  const result = {
    inputTokens: tokens(usage.inputTokens),
    outputTokens: tokens(usage.outputTokens),
    cacheReadTokens: tokens(usage.cacheReadTokens),
    cacheWriteTokens: tokens(usage.cacheWriteTokens),
  };
  return Object.values(result).some((token) => token !== null) ? result : null;
}

export type CursorUsagePayload = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedReadTokens: number | null;
  readonly cachedWriteTokens: number | null;
};

/**
 * Cursor's `inputTokens` counts the prompt without its cache, while the agent-usage
 * collection path expects a total input and subtracts the cache from it. Reporting the
 * total keeps cache reads from being counted a second time as uncached input.
 *
 * No total is reported without the uncached part: a total built from the cache alone
 * would tell the collection path that the whole prompt was cached and report zero
 * uncached input, which is a claim the runtime did not make.
 */
export function cursorUsagePayload(usage: CursorTurnUsage): CursorUsagePayload {
  const input =
    usage.inputTokens === null
      ? null
      : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    inputTokens: input,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cacheReadTokens,
    cachedWriteTokens: usage.cacheWriteTokens,
  };
}

function toolName(call: DynamicRecord): { tool: CursorToolKind; call: DynamicRecord } | null {
  for (const [key, kind] of TOOL_KINDS) {
    const value = getRecord(call, key);
    if (value) return { tool: kind, call: value };
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" ? (getString(block, "text") ?? "") : ""))
    .join("");
}

export function parseCursorStreamLine(line: string): CursorStreamRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(record)) return null;
  const type = getString(record, "type");
  if (!type) return null;

  if (type === "system") {
    const sessionId = getString(record, "session_id");
    return sessionId === null
      ? null
      : { kind: "init", sessionId, model: getString(record, "model"), cwd: getString(record, "cwd") };
  }

  if (type === "assistant") {
    const text = textOf(getRecord(record, "message")?.content);
    return text.length === 0 ? null : { kind: "assistant", text };
  }

  if (type === "tool_call") {
    const call = getRecord(record, "tool_call");
    const named = call ? toolName(call) : null;
    const callId = getString(record, "call_id") ?? getString(named?.call ?? null, "toolCallId");
    if (!named || callId === null) return { kind: "ignored", type };
    const result = getRecord(named.call, "result");
    const failed = result ? !getRecord(result, "success") : false;
    return {
      kind: "tool",
      phase: getString(record, "subtype") === "completed" ? "completed" : "started",
      callId,
      tool: named.tool,
      args: getRecord(named.call, "args"),
      result: result ?? null,
      error: failed ? (getString(getRecord(result, "error"), "message") ?? "failed") : null,
    };
  }

  if (type === "result") {
    return {
      kind: "result",
      sessionId: getString(record, "session_id"),
      requestId: getString(record, "request_id"),
      usage: cursorTurnUsage(getRecord(record, "usage")),
      failed: record.is_error === true,
      error: record.is_error === true ? (getString(record, "result") ?? "error") : null,
    };
  }

  return { kind: "ignored", type };
}

export function cursorToolTitle(record: Extract<CursorStreamRecord, { kind: "tool" }>): string {
  if (record.tool === "execute") return getString(record.args, "command") ?? "shell";
  if (record.tool === "read" || record.tool === "edit") return getString(record.args, "path") ?? record.tool;
  return record.tool;
}

export function cursorToolOutput(record: Extract<CursorStreamRecord, { kind: "tool" }>): string {
  const success = getRecord(record.result, "success");
  if (!success) return record.error ?? "";
  return getString(success, "stdout") ?? getString(success, "content") ?? "";
}
