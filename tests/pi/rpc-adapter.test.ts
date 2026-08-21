import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PiRpcClient, StrictJsonlFrameDecoder } from "../../apps/server/src/pi/adapter.js";

function captureWritable() {
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callback();
    },
  });
  return { stdin, writes };
}

describe("StrictJsonlFrameDecoder", () => {
  it("splits only LF records and accepts CRLF across byte chunks", () => {
    const decoder = new StrictJsonlFrameDecoder();
    expect(decoder.push(Buffer.from('{"type":"agent_start"}\r'))).toEqual([]);
    expect(decoder.push(Buffer.from('\n{"type":"agent_end"}\n'))).toEqual([
      '{"type":"agent_start"}',
      '{"type":"agent_end"}',
    ]);
    decoder.finish();
  });

  it("rejects an unterminated record instead of silently accepting protocol contamination", () => {
    const decoder = new StrictJsonlFrameDecoder();
    decoder.push(Buffer.from('{"type":"agent_start"}'));
    expect(() => decoder.finish()).toThrow("unterminated JSONL frame");
  });
});

describe("PiRpcClient", () => {
  it("writes a correlated LF-framed command and resolves only its matching response", async () => {
    const { stdin, writes } = captureWritable();
    const client = new PiRpcClient(stdin, { idFactory: () => "request-1" });
    const pending = client.getState();
    await expect.poll(() => writes).toEqual(['{"id":"request-1","type":"get_state"}\n']);
    expect(client.handleResponse({
      type: "response",
      command: "get_state",
      success: true,
      id: "request-1",
      data: { sessionId: "session-1" },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ command: "get_state", data: { sessionId: "session-1" } });
  });

  it("rejects unknown and mismatched response correlation instead of settling the wrong command", async () => {
    const { stdin } = captureWritable();
    const client = new PiRpcClient(stdin, { idFactory: () => "request-2" });
    expect(() => client.handleResponse({ type: "response", command: "get_state", success: true, id: "unknown" })).toThrow("unknown correlation id");

    const pending = client.getSessionStats();
    expect(client.handleResponse({ type: "response", command: "get_state", success: true, id: "request-2" })).toBe(true);
    await expect(pending).rejects.toThrow("response command mismatch");
  });

  it("keeps reserved request fields authoritative and rejects reused command IDs", async () => {
    const { stdin, writes } = captureWritable();
    let calls = 0;
    const client = new PiRpcClient(stdin, { idFactory: () => `request-${++calls}` });
    const pending = client.command("get_state", { id: "spoofed", type: "prompt" });
    await expect.poll(() => writes).toEqual(['{"id":"request-1","type":"get_state"}\n']);
    expect(client.handleResponse({ type: "response", command: "get_state", success: true, id: "request-1" })).toBe(true);
    await expect(pending).resolves.toMatchObject({ command: "get_state" });

    const reused = new PiRpcClient(stdin, { idFactory: () => "same-id" });
    const firstRequest = reused.getState();
    await expect(reused.getSessionStats()).rejects.toThrow("not unique");
    reused.rejectPending(new Error("test cleanup"));
    await expect(firstRequest).rejects.toThrow("test cleanup");
  });

  it("rejects malformed response-shaped records instead of treating them as streamed events", () => {
    const { stdin } = captureWritable();
    const client = new PiRpcClient(stdin);
    expect(() => client.handleResponse({ type: "response", command: "get_state", success: "yes", id: "bad" })).toThrow("Invalid Pi RPC response");
  });
});
