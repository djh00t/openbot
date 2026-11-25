import { describe, expect, it } from "vitest";
import { cursorUsageTokens } from "./usage-collection";

/** The three Cursor turns captured from the runtime, unedited. */
const ONE_WORD = { inputTokens: 4, outputTokens: 4, cacheReadTokens: 9664, cacheWriteTokens: 9565 };
const READ_AND_SHELL = { inputTokens: 6, outputTokens: 187, cacheReadTokens: 28968, cacheWriteTokens: 9899 };
const RESUMED = { inputTokens: 4, outputTokens: 8, cacheReadTokens: 19563, cacheWriteTokens: 118 };

describe("cursor usage tokens", () => {
  it("maps the runtime's uncached input without subtracting the cache", () => {
    expect(cursorUsageTokens(READ_AND_SHELL)).toEqual({
      uncachedInput: 6,
      cachedInput: 28968,
      cacheCreation: 9899,
      output: 187,
    });
  });

  it("keeps a small uncached count that the subtraction would have discarded", () => {
    const tokens = cursorUsageTokens(ONE_WORD);
    expect(tokens.uncachedInput).toBe(4);
    expect(tokens.uncachedInput).not.toBeNull();
  });

  it("reads a resumed turn's larger cache without touching its uncached count", () => {
    expect(cursorUsageTokens(RESUMED)).toEqual({
      uncachedInput: 4,
      cachedInput: 19563,
      cacheCreation: 118,
      output: 8,
    });
  });

  it("leaves an unreported value null instead of counting it as zero", () => {
    expect(cursorUsageTokens({ inputTokens: 6, outputTokens: 7 })).toEqual({
      uncachedInput: 6,
      cachedInput: null,
      cacheCreation: null,
      output: 7,
    });
    expect(cursorUsageTokens({})).toEqual({
      uncachedInput: null,
      cachedInput: null,
      cacheCreation: null,
      output: null,
    });
  });
});
