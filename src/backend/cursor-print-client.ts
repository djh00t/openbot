import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentClient, DiagnosticOrigin } from "./agent-client";
import { type CursorCliInfo, cliPathEnvironment, cliSpawnTarget } from "./cli";
import { cursorToolOutput, cursorToolTitle, parseCursorStreamLine } from "./cursor-stream";
import {
  confineSpawnTarget,
  cursorConfinedEnv,
  cursorStatePaths,
  type ProcessConfinement,
  type SpawnTarget,
} from "./process-confinement";
import {
  type AppServerNotification,
  type AppServerRequest,
  getArray,
  getString,
  isRecord,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
  type ThreadItem,
} from "./protocol";
import {
  type ProviderClientOperationError,
  providerFailure,
  providerSync,
  requiredString,
} from "./provider-client-effects";
import { registerProviderProcess } from "./provider-processes";

export const CURSOR_PRINT_ENV = "OPENBOT_CURSOR_PRINT";
const CURSOR_PRINT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 5_000;

interface ClientEvents {
  notification: [AppServerNotification];
  request: [AppServerRequest];
  exit: [Error];
  diagnostic: [string, DiagnosticOrigin?];
}

type CursorPrintTurn = {
  readonly id: string;
  readonly itemId: string;
  stopped: boolean;
  /** Text already sent as deltas. Cursor prints the whole answer again in each partial record. */
  emitted: string;
  itemStarted: boolean;
  finished: boolean;
};

type CursorPrintThread = {
  readonly id: string;
  sessionId: string | null;
  model: string | null;
  child: ChildProcessWithoutNullStreams | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  turn: CursorPrintTurn | null;
};

export type CursorPrintOptions = {
  readonly requestTimeoutMs?: number;
  readonly cwd?: () => string;
  readonly agentEnvironment?: () => Readonly<Record<string, string>>;
  readonly confine?: (target: SpawnTarget) => SpawnTarget;
  readonly confinedEnv?: () => Readonly<Record<string, string>>;
};

export type CursorPrintContext = {
  readonly agentEnvironment?: () => Readonly<Record<string, string>>;
  readonly accountEnvironment?: Readonly<Record<string, string>>;
};

/** Returns null unless the switch is on, so the driver keeps its ACP client untouched. */
export function cursorPrintClient(
  cli: CursorCliInfo,
  timeoutMs: number,
  context: CursorPrintContext,
  confinement?: ProcessConfinement,
): AgentClient | null {
  if (!cursorPrintRequested()) return null;
  const account = { ...context.accountEnvironment };
  return new CursorPrintClient(cli, {
    requestTimeoutMs: timeoutMs,
    agentEnvironment: () => ({ ...(context.agentEnvironment?.() ?? {}), ...account }),
    ...(confinement
      ? {
          confine: (target: SpawnTarget) => confineSpawnTarget(target, confinement, cursorStatePaths()),
          confinedEnv: () => cursorConfinedEnv(),
        }
      : {}),
  });
}

export function cursorPrintRequested(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment[CURSOR_PRINT_ENV] === "1";
}

/**
 * Drives `cursor-agent -p --output-format stream-json`, the only transport on which the runtime
 * reports per-turn token usage. ACP reports none at all. One process per turn, continued with
 * `--resume`, so a turn cannot be steered mid-flight and the runtime's own approval prompts do not
 * exist here: the CLI runs with --force and approvals are its allowlist and sandbox settings.
 */
export class CursorPrintClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "cursor";
  readonly #threads = new Map<string, CursorPrintThread>();
  #running = false;
  constructor(
    private readonly cli: CursorCliInfo,
    private readonly options: CursorPrintOptions = {},
  ) {
    super();
  }
  get running(): boolean {
    return this.#running;
  }
  start(): void {
    this.#running = true;
  }
  notify(): void {}
  respond(_id: RequestId, _value: unknown): void {}
  respondError(_id: RequestId, _error: RpcError): void {}

  readonly stop = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.#running = false;
      for (const thread of this.#threads.values()) this.#endProcess(thread);
      this.#threads.clear();
    });

  readonly request = Effect.fn("CursorPrintClient.request")(function* <T>(
    this: CursorPrintClient,
    method: string,
    params: unknown,
    decoder: ResponseDecoder<T>,
  ): Effect.fn.Return<T, ProviderClientOperationError> {
    if (!this.#running)
      return yield* providerFailure(new Error(sourceText("error.provider.acpProcessStopped", { provider: "Cursor" })));
    let response: unknown;
    switch (method) {
      case "initialize":
      case "plugin/list":
        response = method === "plugin/list" ? { marketplaces: [] } : {};
        break;
      case "account/read":
        response = { account: { type: this.provider, email: null }, requiresOpenaiAuth: false };
        break;
      case "account/rateLimits/read":
        response = { rateLimits: null, rateLimitsByLimitId: null };
        break;
      case "model/list":
        response = { data: [] };
        break;
      case "thread/start":
      case "thread/resume": {
        const id = getString(params, "threadId") ?? randomUUID();
        const existing = this.#threads.get(id);
        const thread = existing ?? { id, sessionId: null, model: null, child: null, killTimer: null, turn: null };
        thread.model = getString(params, "model") ?? thread.model;
        this.#threads.set(id, thread);
        response = { thread: { id } };
        break;
      }
      case "thread/read": {
        const id = yield* providerSync(() => requiredString(params, "threadId"));
        response = { thread: { id, turns: [] } };
        break;
      }
      case "turn/start": {
        const id = yield* providerSync(() => requiredString(params, "threadId"));
        const thread = yield* providerSync(() => this.#thread(id));
        if (thread.turn)
          return yield* providerFailure(new Error(sourceText("error.provider.acpSessionBusy", { provider: "Cursor" })));
        thread.model = getString(params, "model") ?? thread.model;
        const turn = yield* providerSync(() => this.#startTurn(thread, params));
        response = { turn: { id: turn.id, status: "inProgress" } };
        break;
      }
      case "turn/interrupt": {
        const id = yield* providerSync(() => requiredString(params, "threadId"));
        const thread = this.#threads.get(id);
        if (thread) {
          if (thread.turn) thread.turn.stopped = true;
          this.#endProcess(thread);
        }
        response = {};
        break;
      }
      case "thread/compact/start":
        return yield* providerFailure(new Error("The Cursor print transport cannot compact a thread."));
      case "turn/steer":
        return yield* providerFailure(new Error(sourceText("error.backend.steerUnsupported")));
      default:
        return yield* providerFailure(new Error(`Cursor print transport does not implement ${method}.`));
    }
    return yield* providerSync(() => decoder(response));
  });

  #thread(id: string): CursorPrintThread {
    const thread = this.#threads.get(id);
    if (!thread) throw new Error("The Cursor thread is not open.");
    return thread;
  }

  #startTurn(thread: CursorPrintThread, params: unknown): CursorPrintTurn {
    const turn: CursorPrintTurn = {
      id: getString(params, "clientTurnId") ?? randomUUID(),
      itemId: randomUUID(),
      stopped: false,
      emitted: "",
      itemStarted: false,
      finished: false,
    };
    thread.turn = turn;
    this.emit("notification", {
      method: "turn/started",
      params: { threadId: thread.id, turn: { id: turn.id, status: "inProgress" } },
    });
    const prompt = promptText(params);
    if (prompt.length === 0) {
      this.#finish(thread, turn, "failed", sourceText("error.provider.acpNoAnswer", { provider: "Cursor" }));
      return turn;
    }
    const argv = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      ...(thread.model ? ["--model", thread.model] : []),
      ...(thread.sessionId ? ["--resume", thread.sessionId] : []),
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      const direct = cliSpawnTarget(this.cli.executable, argv);
      const target = this.options.confine ? this.options.confine(direct) : direct;
      child = spawn(target.command, target.args, {
        cwd: this.options.cwd?.() ?? process.cwd(),
        env: {
          ...process.env,
          ...cliPathEnvironment(this.cli),
          ...this.options.confinedEnv?.(),
          ...this.options.agentEnvironment?.(),
        },
        windowsVerbatimArguments: target.windowsVerbatimArguments,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      registerProviderProcess(child, this.provider);
    } catch (failure) {
      this.#finish(thread, turn, "failed", failure instanceof Error ? failure.message : String(failure));
      return turn;
    }
    thread.child = child;
    let stderr = "";
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        this.#read(thread, turn, line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.on("error", (failure) => this.#finish(thread, turn, "failed", failure.message));
    child.on("close", (code) => {
      if (buffered.trim().length > 0) this.#read(thread, turn, buffered);
      if (turn.finished) return;
      this.#finish(thread, turn, "failed", stderr.trim() || `Cursor exited with code ${code}.`);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    return turn;
  }

  #read(thread: CursorPrintThread, turn: CursorPrintTurn, line: string): void {
    if (turn.finished) return;
    const record = parseCursorStreamLine(line);
    if (!record) return;
    if (record.kind === "init") {
      thread.sessionId = record.sessionId;
      return;
    }
    if (record.kind === "assistant") {
      this.#appendAnswer(thread, turn, record.text);
      return;
    }
    if (record.kind === "tool") {
      const item = toolItem(record);
      this.emit("notification", {
        method: record.phase === "completed" ? "item/completed" : "item/started",
        params: { threadId: thread.id, turnId: turn.id, item },
      });
      return;
    }
    if (record.kind !== "result") return;
    if (record.sessionId) thread.sessionId = record.sessionId;
    if (record.usage) {
      this.emit("notification", {
        method: "openbot/usage",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          promptId: record.requestId ?? turn.id,
          source: { provider: "cursor", runtime: "cursor-agent" },
          requestId: record.requestId,
          sessionId: record.sessionId ?? thread.sessionId,
          model: thread.model,
          usage: record.usage,
        },
      });
    }
    if (record.failed) {
      this.#finish(thread, turn, turn.stopped ? "interrupted" : "failed", record.error);
      return;
    }
    this.#completeAnswer(thread, turn);
    this.#finish(thread, turn, turn.stopped ? "interrupted" : "completed", null);
  }

  /** Every partial record repeats the whole answer so far, so only the unseen remainder is sent. */
  #appendAnswer(thread: CursorPrintThread, turn: CursorPrintTurn, text: string): void {
    const seen = turn.emitted.length > 0 && text.startsWith(turn.emitted);
    const delta = seen ? text.slice(turn.emitted.length) : text;
    if (delta.length === 0) return;
    if (!turn.itemStarted) {
      turn.itemStarted = true;
      this.emit("notification", {
        method: "item/started",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: { id: turn.itemId, type: "agentMessage", phase: "final_answer" },
        },
      });
    }
    turn.emitted = seen ? text : turn.emitted + delta;
    this.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: turn.id, itemId: turn.itemId, delta },
    });
  }

  #completeAnswer(thread: CursorPrintThread, turn: CursorPrintTurn): void {
    if (!turn.itemStarted || turn.emitted.length === 0) return;
    const item = {
      id: turn.itemId,
      type: "agentMessage",
      phase: "final_answer",
      text: turn.emitted,
    } satisfies ThreadItem;
    this.emit("notification", { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
    turn.itemStarted = false;
  }

  #finish(thread: CursorPrintThread, turn: CursorPrintTurn, status: string, error: string | null): void {
    if (turn.finished) return;
    turn.finished = true;
    this.#endProcess(thread);
    if (error) this.emit("diagnostic", error);
    if (status === "interrupted" || status === "failed") this.#completeAnswer(thread, turn);
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: turn.id, status } },
    });
    if (thread.turn === turn) thread.turn = null;
  }

  #endProcess(thread: CursorPrintThread): void {
    const child = thread.child;
    thread.child = null;
    if (thread.killTimer) {
      clearTimeout(thread.killTimer);
      thread.killTimer = null;
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    thread.killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    thread.killTimer.unref?.();
  }

  /** Bound by the provider driver so a turn that never returns a result record cannot hang for ever. */
  requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? CURSOR_PRINT_TIMEOUT_MS;
  }
}

function toolItem(record: Extract<ReturnType<typeof parseCursorStreamLine>, { kind: "tool" }>): ThreadItem {
  const completed = record.phase === "completed";
  return {
    id: record.callId,
    type: "toolCall",
    name: cursorToolTitle(record),
    toolKind: record.tool,
    status: completed ? (record.error ? "failed" : "completed") : "inProgress",
    ...(record.args ? { arguments: record.args } : {}),
    ...(completed ? { result: cursorToolOutput(record) } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function promptText(params: unknown): string {
  const parts: string[] = [];
  for (const item of getArray(params, "input")) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if ((item.type === "mention" || item.type === "localImage") && typeof item.path === "string")
      parts.push(`Attached local file: ${item.path}`);
  }
  const developer = getString(params, "developerInstructions");
  return developer
    ? `<openbot-developer-instructions>\n${developer}\n</openbot-developer-instructions>\n\n${parts.join("\n\n")}`
    : parts.join("\n\n");
}
