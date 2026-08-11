# M001 Local Acceptance

This document is the repeatable local acceptance contract for the workspace safety boundary.

## CI-quality commands

Run from the repository root:

```bash
npm test
npm run test:integration
npm run test:browser
npm run acceptance:local
npm run build
```

The deterministic E2E fixture at `tests/e2e/safety-workflow.test.ts` exercises the complete local path: project open, document edit, anchored comment, dirty-checkpoint rejection, successful Pi run, run event/error reporting, proposal diff, proposal edit and keep, proposal reject, and canonical restore.

## Local integration checks

`npm run acceptance:local` performs real local checks without writing to the repository:

- **Editor:** TypeScript compilation and the Markdown editor fidelity test.
- **Git:** Initializes a temporary repository, configures an isolated identity, commits a fixture, and verifies a clean status.
- **Pi:** Runs `preflight:pi` against the configured local Pi executable and its JSONL profile.
- **Zotero:** Reported as optional availability only. Zotero is not installed in the current acceptance environment, so this check is recorded as unavailable without failing acceptance.

Temporary acceptance fixtures are removed in the runner's `finally` block. No credentials, project files, or generated dependencies are required.
