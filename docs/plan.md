# Margin — Project Plan

## 1. Project Summary

**Margin** is a local-first research and writing workspace built around a human-review → AI-revision loop.

It should replace the current workflow of:

1. manually creating a research folder,
2. running Pi to research a topic,
3. storing sources separately,
4. having Pi write a Markdown report/paper,
5. reviewing the Markdown manually,
6. writing revision notes elsewhere,
7. giving those notes back to Pi,
8. manually inspecting the resulting changes.

Margin should provide a clean visual workspace where the user can:

- create research projects/topics,
- ask Pi to research and draft,
- read/edit Markdown in a pleasant document editor,
- highlight text and attach comments,
- send those comments back to Pi as revision instructions,
- inspect what changed,
- accept or revert changes,
- browse sources and citations,
- use either local/self-hosted or cloud models,
- retain all important project data as portable files,
- use Git for version history.

The application is primarily an **interface and workflow layer around Pi, Markdown, Git, and research sources**.

Do not attempt to replace these components unnecessarily.

---

# 2. Core Design Principles

## 2.1 Local-first

Projects and documents should exist as normal files on disk.

A user should be able to open the project folder without Margin and still find readable Markdown, sources, and Git history.

Avoid proprietary document storage as the source of truth.

## 2.2 Markdown is canonical

Documents are stored as `.md` files.

The visual editor may internally convert Markdown into an editor document model while editing, but it must reliably serialize back to Markdown.

Do not make editor-specific JSON the authoritative document format.

Round-trip safety is more important than supporting every rich-text feature.

## 2.3 Git provides document version control

Do not build a custom version-control system.

Use Git for:

- checkpoints,
- revision history,
- diffs,
- rollback,
- agent-change tracking.

The UI should hide unnecessary Git complexity from the user.

## 2.4 Pi remains the agent

Do not recreate Pi inside Margin.

Margin should invoke Pi with appropriate project context and structured instructions.

Pi handles work such as:

- web research,
- source collection,
- drafting,
- complex revisions,
- citation checking,
- multi-file changes.

Simple operations may call an LLM directly later, but Pi should remain the initial agent integration.

## 2.5 Human review is first-class

The core interaction loop is:

```text
Research
   ↓
Draft
   ↓
Human reads
   ↓
Highlights/comments
   ↓
Pi addresses comments
   ↓
Diff
   ↓
Human reviews
   ↓
Accept / modify / revert
   ↓
Repeat
```

Do not optimize the application around autonomous document generation.

Optimize it around **human-guided iterative research and writing**.

## 2.6 Sources are generic

A source is not necessarily a journal article or PDF.

Examples:

- PDF
- webpage
- HTML snapshot
- Word document
- spreadsheet
- CSV
- local document
- government report
- Git repository
- dataset
- academic paper
- book
- other downloadable file

The basic rule should be:

> Preserve the source material actually used whenever reasonably possible.

Prefer an archived/downloaded source over storing only a URL.

Always retain the original URL when applicable.

---

# 3. Scope of V1

Build only enough to make the existing research workflow substantially better.

V1 should contain:

1. Project management
2. Markdown document editor
3. Inline comments
4. Pi integration
5. Source browser
6. Git versioning/diffs
7. Model/provider configuration
8. Optional Zotero integration

Everything else should be considered later.

---

# 4. Explicit Non-Goals

Do NOT initially build:

- custom vector database
- custom RAG framework
- multi-agent orchestration system
- CRDT / Google-Docs-style multiplayer editing
- knowledge graph
- autonomous peer reviewer
- reference manager replacement
- full LaTeX editor
- journal submission system
- citation graph visualization
- automatic manuscript formatting for every journal
- custom version-control system
- mobile application
- elaborate plugin architecture
- workflow/state-machine framework unless clearly required
- proprietary document format

Avoid premature abstractions.

If a simple function or interface solves the current requirement, use it.

---

# 5. Proposed Technology Stack

This is a starting recommendation, not a mandate.

Validate it early during Milestone 1.

## Frontend

- React
- TypeScript
- Vite
- rich-text editor built on ProseMirror/Tiptap or another suitable editor
- simple component library if helpful

## Backend

Prefer TypeScript/Node initially so frontend and backend can share types.

Possible stack:

- Node.js
- Fastify
- SQLite
- Drizzle ORM or similarly lightweight SQLite layer

Avoid Next.js unless it provides a concrete advantage.

This application does not need SSR, SEO, React Server Components, or most of Next.js's framework machinery.

A small SPA + local API server is likely simpler.

## Storage

```text
Filesystem → documents/sources/research
SQLite     → UI/application metadata
Git        → versions/history
Zotero     → optional external source library
```

## Agent

- Pi CLI

## Model APIs

Start with:

- OpenAI-compatible API

This covers local servers such as llama.cpp and many hosted services.

Add native provider adapters only where there is a concrete reason.

---

# 6. Architecture

Keep architecture intentionally boring.

```text
┌─────────────────────────────────────┐
│              Browser                │
│                                     │
│ React UI                            │
│ Editor / comments / sources / diff │
└──────────────────┬──────────────────┘
                   │
                   │ local HTTP
                   ▼
┌─────────────────────────────────────┐
│          Margin Server              │
│                                     │
│ Project service                     │
│ Document service                    │
│ Comment service                     │
│ Git service                         │
│ Pi service                          │
│ Source service                      │
│ Zotero adapter                      │
│ Model configuration                 │
└──────┬──────────┬──────────┬────────┘
       │          │          │
       ▼          ▼          ▼
   Filesystem    Git        Pi CLI
       │
       ▼
    Zotero
   optional
```

Do not introduce microservices.

One backend process is sufficient.

---

# 7. Project Structure

A Margin project should remain understandable without Margin installed.

Example:

```text
project-name/
├── margin.yaml
│
├── documents/
│   ├── report.md
│   └── notes.md
│
├── research/
│   ├── research-notes.md
│   └── search-log.md
│
├── sources/
│   └── manifest.yaml
│
└── .git/
```

If sources are stored locally:

```text
sources/
├── manifest.yaml
├── smith-2025.pdf
├── alberta-policy.html
└── dataset.csv
```

If Zotero owns the source:

```yaml
- id: smith2025
  backend: zotero
  zotero_key: ABC123
```

Local sources:

```yaml
- id: alberta_policy
  backend: local
  path: sources/alberta-policy.html
  url: https://example.com/policy
```

The rest of Margin should not care whether a source came from Zotero or local storage.

---

# 8. Source Model

Create a simple internal source abstraction.

Conceptually:

```ts
interface Source {
  id: string
  type: string

  title: string
  authors?: string[]
  year?: number

  url?: string
  doi?: string

  accessedAt?: string

  storage:
    | {
        type: "local"
        path: string
      }
    | {
        type: "zotero"
        itemKey: string
      }

  attachments?: SourceAttachment[]
}
```

Do not over-model bibliographic metadata initially.

Zotero can remain the authority for sophisticated bibliographic metadata.

---

# 9. Source Capture Philosophy

When Pi discovers and uses a source:

```text
Source discovered
       ↓
Can original artifact be downloaded?
       │
 ┌─────┴─────┐
 yes          no
 │             │
 ▼             ▼
Download      Capture webpage
artifact      where possible
 │             │
 └──────┬──────┘
        ▼
Record metadata
        ↓
Record original URL
        ↓
Add source to project/library
```

Examples:

### Journal article

Prefer:

```text
DOI
PDF
metadata
original URL
```

### Government report

Prefer:

```text
original PDF/DOCX/XLSX/etc.
metadata
original webpage URL
```

### Web-only source

Prefer:

```text
URL
access date
archived HTML/snapshot where possible
```

### Dataset

Prefer:

```text
CSV/XLSX/JSON/etc.
landing-page URL
metadata
```

### Git repository

Prefer:

```text
repository URL
commit/tag when relevant
access date
```

Avoid converting everything to PDF unnecessarily.

Preserve the best representation of the original evidence.

---

# 10. Zotero Integration

Zotero integration should be supported but **optional**.

Margin must work without Zotero.

Use an adapter boundary:

```text
SourceRepository
     │
     ├── LocalSourceRepository
     │
     └── ZoteroSourceRepository
```

Initial Zotero functionality should be small:

- detect/configure local Zotero
- search library
- retrieve item metadata
- retrieve attachments
- associate a Zotero item with a Margin project
- optionally add a newly discovered source

Do not build a Zotero replacement.

Do not directly manipulate Zotero's SQLite database.

Use supported APIs.

---

# 11. Project Dashboard

Initial home screen:

```text
Margin

Projects

┌────────────────────────────┐
│ Rural Medical Education    │
│ Updated 20 min ago         │
│ 17 sources                 │
└────────────────────────────┘

┌────────────────────────────┐
│ GLP-1 Review               │
│ Updated yesterday          │
│ 31 sources                 │
└────────────────────────────┘

+ New Project
```

Functions:

- create
- open
- rename
- archive/delete
- show last updated
- show document/source counts

Do not add complex organization yet.

---

# 12. Main Workspace

Target layout:

```text
┌──────────────┬────────────────────────────┬──────────────────┐
│ PROJECT      │ DOCUMENT                   │ CONTEXT          │
│              │                            │                  │
│ Documents    │ # Rural Medical Education │ Comments         │
│ Research     │                            │                  │
│ Sources      │ Evidence suggests... [1]  │ Sources          │
│              │                            │                  │
│              │ Another study... [2]      │ AI               │
│              │                            │                  │
└──────────────┴────────────────────────────┴──────────────────┘
```

Suggested left sidebar:

- Documents
- Research
- Sources
- History

Suggested right sidebar tabs:

- Comments
- Source details
- AI

The center remains focused on the document.

---

# 13. Markdown Editor Foundation Check

This is part of **Milestone 1**, not a separate spike milestone.

Before building heavily around a particular editor, quickly prove that the editor is suitable.

Evaluate Tiptap/ProseMirror first, but do not assume it is automatically the right choice.

Test:

1. load Markdown file,
2. render visually,
3. edit text,
4. headings,
5. lists,
6. emphasis,
7. links,
8. block quotes,
9. tables if practical,
10. citation syntax such as `[@smith2025]`,
11. serialize back to Markdown,
12. reopen result,
13. verify no destructive transformations,
14. repeat the round trip several times.

Test:

```text
Markdown
→ editor
→ Markdown
→ editor
→ Markdown
```

The resulting Markdown must remain stable enough for Git diffs and Pi editing.

Also quickly prove:

- selected text can support a comment/highlight,
- Pi can be invoked from the backend in a chosen project directory,
- Git checkpoint → diff → restore works,
- Zotero local API connectivity is feasible if Zotero is installed.

These are implementation checks, not separate deliverables.

If Tiptap's Markdown handling creates unacceptable churn, switch editors before building further.

Do not spend excessive time comparing editors once one passes the required tests.

---

# 14. Comments

Comments are one of the most important features.

User flow:

1. highlight text,
2. click Comment,
3. enter instruction,
4. comment appears in sidebar,
5. clicking comment highlights target text.

Example:

```text
Selected:

"Several studies demonstrated significant improvement."

Comment:

"Give actual numbers and cite the strongest study."
```

Comment statuses:

```text
open
addressed
resolved
```

Keep this simple.

---

# 15. Comment Anchoring

Do NOT insert comments directly into Markdown initially.

Store them in SQLite.

Example conceptual record:

```ts
interface Comment {
  id: string
  projectId: string
  documentPath: string

  selectedText: string

  anchor: {
    from: number
    to: number
  }

  surroundingText?: string

  body: string

  status: "open" | "addressed" | "resolved"

  createdAt: string
}
```

Character positions alone will break when documents change.

Therefore use a resilient anchor strategy containing:

- selected text,
- approximate position,
- surrounding prefix/suffix.

When reopening after external edits:

1. attempt exact position,
2. validate selected text,
3. search nearby,
4. search document for unique selected text,
5. mark comment as detached if location cannot be determined reliably.

Do not build a complex CRDT anchoring algorithm in V1.

---

# 16. Pi Integration

Create a dedicated Pi service.

Conceptually:

```ts
interface PiService {
  runResearch(...)
  draftDocument(...)
  addressComments(...)
  customTask(...)
}
```

Underneath, invoke the installed Pi CLI.

Do not import or reimplement Pi internals.

Capture:

- stdout
- stderr
- exit status
- start/end time
- changed files

The UI should show useful progress/output without becoming a terminal emulator.

---

# 17. Address Comments Workflow

This is the primary AI workflow.

User reviews document and creates comments.

Then clicks:

```text
Address Comments
```

Margin creates a Git checkpoint before allowing Pi to edit.

Example generated instruction:

```text
Revise documents/report.md according to the review comments below.

COMMENT 1

Selected text:
"Several studies demonstrated significant improvement."

Reviewer instruction:
"Give actual numbers and cite the strongest study."

COMMENT 2

Selected text:
"..."

Reviewer instruction:
"This conclusion seems stronger than the cited evidence. Recheck it."

Requirements:

- Preserve valid citations.
- Research additional evidence when necessary.
- Add newly used sources to the source library.
- Do not fabricate citations.
- Do not resolve a comment unless it has actually been addressed.
- Keep unrelated sections unchanged where possible.
```

Run Pi from the project directory.

After completion:

```text
Before revision commit
        ↓
Pi edits files
        ↓
Git diff
        ↓
Review Changes screen
```

Do not automatically hide the changes from the user.

---

# 18. Git Workflow

Git should be managed by Margin.

On project creation:

```text
git init
initial commit
```

Before agent work:

```text
checkpoint current state
```

After agent work:

```text
working tree contains proposed changes
```

User sees diff.

Then:

### Keep

Commit changes:

```text
Address review comments
```

### Revert

Restore files to checkpoint.

### Edit further

Return to editor with working changes intact.

Avoid complex branching initially.

A linear history is enough.

---

# 19. History Screen

Show human-friendly history rather than raw Git.

Example:

```text
Version History

Aug 10 13:42
Address review comments

Aug 10 12:58
Draft discussion section

Aug 10 11:21
Initial research report
```

Selecting a revision should allow:

- view changed files
- view diff
- restore document/project to revision

Use Git internally.

Do not expose reset/rebase/cherry-pick terminology unless necessary.

---

# 20. Diff Viewer

V1 can use a standard textual Markdown diff.

Example:

```diff
- Several studies demonstrated significant improvement.

+ A 2025 cohort study reported a 17% relative increase
+ in rural practice retention [@smith2025].
```

Support:

- additions
- deletions
- changed files

Initially acceptance can occur at the **whole revision** level.

Do NOT build Google Docs-style per-sentence Accept/Reject Track Changes in V1.

That can come later.

---

# 21. Research Workflow

From a new project:

```text
New Project
     ↓
Research topic
     ↓
Enter research question
     ↓
Pi runs research
     ↓
Sources collected
     ↓
Research notes generated
     ↓
Optional report generated
```

Example command from UI:

```text
Research:

What evidence supports distributed medical
education increasing rural physician retention?

Output:
○ Research only
● Research + report
```

Pi should operate within the normal project filesystem.

Margin should not attempt to independently orchestrate search agents.

---

# 22. Sources UI

Project source panel:

```text
Sources                          18

[PDF] Smith et al. 2025
      Rural training outcomes

[WEB] University of Alberta
      Rural medical education

[XLSX] Alberta Health
       Physician workforce data
```

Selecting a source should show available metadata:

```text
Smith et al. 2025

Type: Journal article
DOI: ...
URL: ...
Captured: ...
Stored: Zotero

Used in:
report.md
```

Provide:

- open original URL
- open local attachment
- open in Zotero where possible

Do not build an elaborate embedded PDF reader initially.

Opening the actual file is sufficient.

---

# 23. Citation Representation

Prefer stable citation identifiers.

Example Markdown:

```markdown
Distributed training may increase rural retention
[@smith2025].
```

Do not use citation numbers as source identifiers.

Numbers can change when references are reordered.

Internally:

```text
smith2025
```

may render as:

```text
[12]
```

in a future formatted view.

For V1, preserving valid source keys and linking them to source records is more important than implementing every citation style.

---

# 24. Citation Safety

Academic provenance is important.

Margin/Pi should follow these rules:

1. Never fabricate references.
2. Every citation key should map to a known source.
3. Whenever possible, retain the source artifact actually inspected.
4. Record the original URL.
5. Record access/capture time for web material.
6. If Pi cannot verify a reference, flag it instead of inventing metadata.

Later we can add DOI/metadata validation through services such as Crossref, PubMed, or OpenAlex.

Do not make this a V1 requirement.

---

# 25. Model Configuration

Separate the concepts of:

```text
Agent
```

and

```text
Model
```

Pi is an agent.

Qwen, GPT, Claude, etc. are models.

V1 configuration should support OpenAI-compatible endpoints.

Example:

```text
Provider: Local llama.cpp

Base URL:
http://server:8080/v1

Model:
Qwen...
```

And:

```text
Provider: Cloud

Base URL:
...

API key:
...

Model:
...
```

API credentials must not be committed into project Git repositories.

Store secrets using environment/config storage appropriate for the deployment.

---

# 26. Direct LLM Calls

Do not implement extensive direct-LLM functionality initially.

Pi can handle agent tasks.

Later, simple operations may bypass Pi:

```text
Fix grammar
Shorten paragraph
Explain selected text
Suggest heading
```

Architecture should permit this, but don't build it until the main workflow works.

---

# 27. Application Metadata

Use SQLite for application state that does not belong in Markdown.

Possible tables:

```text
projects
comments
agent_runs
settings
document_ui_state
```

Do not store entire canonical documents in SQLite.

The filesystem remains authoritative for documents.

---

# 28. External File Changes

Pi will modify Markdown outside the editor process.

The application must therefore handle filesystem changes safely.

Implement filesystem watching.

If the current document changes externally:

- detect change,
- reload safely,
- warn if there are unsaved local editor changes,
- never silently overwrite conflicting user edits.

This is a critical requirement because Pi and Margin will both interact with the same files.

---

# 29. Agent Runs

Track Pi operations.

Example:

```text
Research rural retention

Started: 13:02
Completed: 13:09

Files changed:
research/research-notes.md
documents/report.md
sources/manifest.yaml

Sources added: 14
```

Store run metadata in SQLite.

Do not store every token or create an elaborate observability platform.

---

# 30. Security

Pi may run shell/filesystem operations.

For V1:

- Pi runs only inside configured project directories.
- Never expose arbitrary filesystem browsing to remote clients without safeguards.
- Bind server locally by default.
- Require explicit configuration to expose over LAN/Tailscale.
- Never put API keys into project files.
- Sanitize project path handling.
- Do not execute commands constructed directly from untrusted browser text.

---

# 31. Milestones

## Milestone 1 — Foundation + Workspace

Goal:

Build the basic application while validating the few technical assumptions that could create downstream problems.

### Foundation checks

Before investing heavily in the UI:

- prove Markdown → editor → Markdown round-tripping is acceptably stable,
- prove a text selection can support a lightweight comment/highlight,
- prove Pi can be invoked from the backend inside a project directory,
- prove Git checkpoint → diff → restore works,
- briefly prove Zotero local API connectivity if Zotero is installed.

If any of these assumptions fail, adjust the implementation immediately rather than preserving the original architecture.

Do not turn these checks into a separate milestone or lengthy research exercise.

### Build

- scaffold minimal frontend/backend,
- create project,
- open project,
- initialize Git,
- file/document browser,
- Markdown editor,
- autosave,
- filesystem watching.

### Acceptance test

A user can create a project, edit `report.md`, close Margin, and confirm that the file is ordinary valid Markdown.

Repeated opening and saving should not create meaningless Git diff churn.

---

## Milestone 2 — Comments

Build:

- highlight text,
- create comment,
- sidebar,
- edit/delete comment,
- resolve/reopen,
- resilient anchors.

Acceptance test:

Comments survive application restart and remain associated with their selected text after ordinary nearby edits.

---

## Milestone 3 — Git History

Build:

- automatic checkpoint,
- version history,
- diff viewer,
- restore/revert.

Acceptance test:

Make three document revisions and successfully inspect and restore any previous revision.

---

## Milestone 4 — Pi Revision Loop

Build:

- Pi service,
- Address Comments,
- structured comment prompt,
- pre-run Git checkpoint,
- post-run diff,
- Keep/Revert.

Acceptance test:

1. open report,
2. add two comments,
3. click Address Comments,
4. Pi modifies document,
5. inspect diff,
6. keep revision,
7. verify Git history.

This milestone represents the first genuinely useful Margin workflow.

---

## Milestone 5 — Research Workflow

Build:

- Research button,
- research prompt/input,
- run Pi,
- display run state,
- allow Pi to populate research/docs/sources,
- show newly changed files.

Acceptance test:

Create an empty project and conduct a complete research → report workflow without opening a terminal.

---

## Milestone 6 — Sources

Build:

- source manifest,
- source list,
- metadata panel,
- open local source,
- open URL,
- connect citations to known sources where possible.

Acceptance test:

A report citation can be traced from document → source entry → archived/local/original source.

---

## Milestone 7 — Zotero

Build optional Zotero adapter.

Minimum:

- enable/disable integration,
- connect to local Zotero,
- search Zotero,
- associate item with project,
- inspect attachments,
- open Zotero item/source,
- add source if practical through supported API.

Margin must continue working if Zotero is unavailable.

---

## Milestone 8 — Model Settings

Build:

- provider settings,
- OpenAI-compatible endpoint configuration,
- local/cloud model configuration,
- secure secrets handling.

Only connect this to functions that actually need direct model access.

Avoid building a provider framework larger than necessary.

---

# 32. Testing Strategy

Testing should be proportional.

Do not recreate an excessive-gate problem.

Prioritize tests around data-loss and workflow boundaries.

## Unit tests

Focus on:

- Markdown conversion,
- comment anchoring,
- source manifests,
- Git wrapper,
- path validation,
- prompt construction.

## Integration tests

High value:

```text
editor → Markdown → filesystem
```

```text
comments → Pi prompt
```

```text
Pi change → Git diff
```

```text
Git revision → restore
```

```text
source manifest → source UI
```

## E2E tests

Keep few but meaningful.

Critical workflow:

```text
create project
→ edit document
→ comment
→ address comments
→ inspect revision
→ keep changes
```

Second workflow:

```text
create project
→ research
→ report appears
→ sources appear
```

Do not generate hundreds of low-value UI tests.

---

# 33. Quality Gates

Before declaring V1 successful:

### Data portability

Deleting Margin should not make projects unreadable.

### Markdown stability

Opening/saving repeatedly should not produce noisy meaningless diffs.

### No silent data loss

Conflicting external edits must be detected.

### Git rollback

Any accepted Pi revision must be reversible.

### Source provenance

A source used in a report should be traceable to its original URL/file/library item.

### Pi independence

Margin must not depend on undocumented Pi internals when CLI invocation is sufficient.

### Zotero independence

Margin must function when Zotero is disabled.

### UI usability

Normal research/revision should not require opening a terminal.

---

# 34. V1 Success Scenario

The project is successful when the following interaction works comfortably:

```text
Open Margin
     ↓
Create "Rural Medical Education"
     ↓
Click Research
     ↓
Ask:
"Does distributed medical education
increase rural physician retention?"
     ↓
Pi researches
     ↓
sources are captured
     ↓
report.md appears
     ↓
read report visually
     ↓
highlight questionable sentence
     ↓
comment:
"Find stronger evidence for this."
     ↓
highlight conclusion
     ↓
comment:
"This overstates the evidence."
     ↓
click Address Comments
     ↓
Pi researches/edits
     ↓
Margin shows Git diff
     ↓
user keeps changes
     ↓
comments marked addressed
     ↓
continue reviewing
```

If this loop is excellent, the project has succeeded.

Everything else is secondary.

---

# 35. Future Ideas — Do Not Build Yet

Maintain as backlog only:

- word-level Track Changes,
- accept/reject individual AI edits,
- Zotero library-wide semantic search,
- search existing library before web research,
- PubMed API integration,
- Crossref/OpenAlex metadata verification,
- DOCX import/export,
- LaTeX export,
- bibliography style rendering,
- citation verification dashboard,
- source quote/evidence viewer,
- source-to-claim mapping,
- PDF annotation support,
- project templates,
- shared projects,
- mobile reading/review,
- automatic source deduplication,
- branches/alternate drafts,
- manuscript submission formatting.

Do not allow these to delay the core workflow.

---

# 36. First Task for the Coding Agent

Start with **Milestone 1 — Foundation + Workspace**.

Do not spend a separate milestone researching the architecture.

At the beginning of implementation:

1. inspect the locally installed Pi CLI enough to determine the cleanest invocation method,
2. scaffold the smallest viable React/TypeScript + backend application,
3. test the chosen Markdown editor with repeated round-tripping,
4. test a text-selection comment/highlight,
5. invoke Pi against a temporary Margin project,
6. test Git checkpoint → edit → diff → restore,
7. test basic Zotero local API access if Zotero is available,
8. adjust the stack immediately if any foundational assumption proves unsuitable,
9. continue directly into the project/document workspace.

Do not create unnecessary design documents before coding.

Record important architectural decisions briefly in the repository README or a small `DECISIONS.md` only when they are genuinely useful.

When choosing between implementations, optimize for:

1. simplicity,
2. maintainability,
3. data portability,
4. reliable Markdown,
5. easy Pi integration.

Do not optimize for hypothetical future scale.

---

# 37. Guiding Question

Whenever adding complexity, ask:

> Does this make the research → review → revise loop meaningfully better right now?

If not, defer it.
