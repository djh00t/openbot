import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeUsageTokens, type UsageTokens } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { collectProviderUsage } from "../src/backend/agent/usage-collection";
import { AgentUsage } from "../src/backend/database/agent-usage";
import { DatabaseCore } from "../src/backend/database/database-core";
import { databaseRows, requiredStringColumn } from "../src/backend/database/database-rows";

const AGENT_ID = "agent-usage-e2e";
const MODEL = "claude-opus-5-5";
const REPORT_PATH = ".openbot-build/usage-collection-cursor-e2e.json";

type Fixture = {
  readonly name: string;
  readonly promptId: string;
  readonly usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  readonly expected: { uncachedInput: number; cachedInput: number; cacheCreation: number; output: number };
};

const fixtures: readonly Fixture[] = [
  {
    name: "one-word",
    promptId: "4d286ed7-5225-420e-99c6-be9f0928fb30",
    usage: { inputTokens: 4, outputTokens: 4, cacheReadTokens: 9664, cacheWriteTokens: 9565 },
    expected: { uncachedInput: 4, cachedInput: 9664, cacheCreation: 9565, output: 4 },
  },
  {
    name: "read-and-shell",
    promptId: "739eb64f-6dd5-4edd-afb4-4b6fb9f14f34",
    usage: { inputTokens: 6, outputTokens: 187, cacheReadTokens: 28968, cacheWriteTokens: 9899 },
    expected: { uncachedInput: 6, cachedInput: 28968, cacheCreation: 9899, output: 187 },
  },
  {
    name: "resumed",
    promptId: "7e48e529-0f1e-4085-92a6-3ab49365ccc1",
    usage: { inputTokens: 4, outputTokens: 8, cacheReadTokens: 19563, cacheWriteTokens: 118 },
    expected: { uncachedInput: 4, cachedInput: 19563, cacheCreation: 118, output: 8 },
  },
];

type TurnResult = {
  name: string;
  counterId: string;
  reported: Fixture["usage"];
  recorded: UsageTokens;
  expected: Fixture["expected"];
};

type Report = {
  agentId: string;
  model: string;
  result: "pass" | "fail";
  turns: TurnResult[];
  failure?: string;
};

function tokensOf(value: string): UsageTokens {
  return decodeUsageTokens(JSON.parse(value));
}

const userDataPath = mkdtempSync(join(tmpdir(), "openbot-usage-e2e-"));
const core = new DatabaseCore({ userDataPath });
const report: Report = { agentId: AGENT_ID, model: MODEL, result: "fail", turns: [] };
try {
  await Effect.runPromise(core.initialize());
  const usage = new AgentUsage(core);
  const since = new Date(Date.now() - 60_000).toISOString();
  const turns: TurnResult[] = [];
  for (const fixture of fixtures) {
    const sessionId = `session-${fixture.name}`;
    const turnId = `turn-${fixture.name}`;
    collectProviderUsage(
      usage,
      { id: AGENT_ID, model: MODEL },
      { id: sessionId, provider: "cursor", createdAt: new Date().toISOString() },
      "openbot/usage",
      { threadId: sessionId, turnId, promptId: fixture.promptId, usage: fixture.usage },
    );

    const counterId = `${sessionId}:cursor:${fixture.promptId}`;
    const checkpoint = core.connection
      .prepare("SELECT tokens_json FROM agent_usage_checkpoints WHERE agent_id = ? AND counter_id = ?")
      .get(AGENT_ID, counterId);
    assert.ok(checkpoint, `${fixture.name}: no checkpoint for ${counterId}`);
    const recorded = databaseRows(
      core.connection
        .prepare("SELECT provider, model, tokens_json FROM agent_usage_records WHERE agent_id = ? AND turn_id = ?")
        .all(AGENT_ID, turnId),
    );
    assert.equal(recorded.length, 1, `${fixture.name}: expected one usage record`);
    const row = recorded[0];
    if (!row) throw new Error(`${fixture.name}: usage record missing`);
    assert.equal(requiredStringColumn(row, "provider"), "cursor", `${fixture.name}: provider`);
    assert.equal(requiredStringColumn(row, "model"), MODEL, `${fixture.name}: model`);

    const tokens = tokensOf(requiredStringColumn(row, "tokens_json"));
    assert.deepEqual(tokens, fixture.expected, `${fixture.name}: recorded tokens`);
    const readBack = usage.readTurn(AGENT_ID, turnId, since);
    assert.equal(readBack.length, 1, `${fixture.name}: readTurn`);
    assert.equal(readBack[0]?.provider, "cursor", `${fixture.name}: readTurn provider`);

    turns.push({
      name: fixture.name,
      counterId,
      reported: fixture.usage,
      recorded: tokens,
      expected: fixture.expected,
    });
  }
  report.turns = turns;
  report.result = "pass";
  mkdirSync(".openbot-build", { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`usage-collection-cursor-e2e: pass, ${fixtures.length} turns, ${REPORT_PATH}\n`);
} catch (failure) {
  report.result = "fail";
  report.failure = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
  mkdirSync(".openbot-build", { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`usage-collection-cursor-e2e: fail, ${String(report.failure)}\n`);
  process.exitCode = 1;
} finally {
  core.close();
  rmSync(userDataPath, { recursive: true, force: true });
}
