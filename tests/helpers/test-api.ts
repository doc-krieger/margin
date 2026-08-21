import { strict as assert } from "node:assert";
import { afterEach as nodeAfterEach, describe as nodeDescribe, it as nodeIt } from "node:test";

const vitestApi = process.env.VITEST ? await import("vitest") : undefined;

export const describe = vitestApi?.describe ?? nodeDescribe;
export const it = vitestApi?.it ?? nodeIt;
export const afterEach = vitestApi?.afterEach ?? nodeAfterEach;
export const expect = vitestApi?.expect ?? (<T>(actual: T) => ({
  toBe(expected: unknown): void {
    assert.strictEqual(actual, expected);
  },
  toBeNull(): void {
    assert.strictEqual(actual, null);
  },
  toContain(expected: unknown): void {
    assert.ok(
      typeof actual === "string"
        ? actual.includes(String(expected))
        : Array.isArray(actual) && actual.includes(expected),
      `Expected value to contain ${String(expected)}`,
    );
  },
  toEqual(expected: unknown): void {
    assert.deepStrictEqual(actual, expected);
  },
  not: {
    toBeNull(): void {
      assert.notStrictEqual(actual, null);
    },
  },
}));
