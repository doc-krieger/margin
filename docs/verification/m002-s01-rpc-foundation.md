# M002 S01 RPC and Research Foundation Verification

This note records the deterministic proof for the Pi RPC migration and research-run continuity foundation. It intentionally does not claim source capture, outward web access, or report generation.

## Required verification

Run from the repository root:

```bash
npm test
npm run typecheck
npm run build
npm run acceptance:local
```

The focused continuity checks are also useful during development:

```bash
npm test -- tests/e2e/safety-workflow.test.ts tests/integration/runs/orchestration.test.ts tests/integration/git-pi/git-pi.test.ts tests/integration/research/research-orchestration.test.ts
```

## Deterministic continuity and failure coverage

- `tests/pi/rpc-adapter.test.ts` and `tests/integration/git-pi/git-pi.test.ts` cover correlated RPC responses, CRLF/LF framing, streamed events, malformed protocol output, bounded diagnostics, process exit, timeout, and abort settlement.
- `tests/integration/research/research-orchestration.test.ts` proves required capability denial prevents executor invocation, cancellation is idempotent, and a fresh service reconstructs an active file-backed run as `RESEARCH_PROCESS_LOST` while preserving partial artifact references and ordered reconnect replay.
- `tests/integration/runs/orchestration.test.ts` and `tests/e2e/safety-workflow.test.ts` retain M001 revision handoff, reject cancellation, timeout diagnostics, and checkpoint cleanup coverage.
- File-backed records are atomically replaced and event files are append-only, sequence-validated evidence. Malformed records/events fail closed rather than being treated as successful research.

## Installed Pi smoke boundary

`npm run preflight:pi` performs executable discovery followed by RPC `get_state` and `get_session_stats`. The acceptance runner parses the JSON result and labels this as a state/statistics smoke only. It starts no model prompt, makes no outward web request, and does not expose credentials. A version match is informational; executable and RPC smoke availability are the acceptance criteria.

Capability policy remains explicit: `pi --version` alone does not grant web or other external capabilities. Required capabilities must have executable and RPC smoke evidence plus configured policy and presented-tool evidence.

## Observability and recovery surfaces

Research records expose status, current stage, session statistics, last-event timestamps, cancellation metadata, partial artifacts, bounded terminal diagnostics, and process-exit context. Events are replayable by sequence through the research API/SSE path. On service reconstruction, any active record is durably transitioned to failed with `RESEARCH_PROCESS_LOST` before the terminal event is emitted.
