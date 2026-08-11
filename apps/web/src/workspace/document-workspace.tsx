import { useEffect, useMemo, useState } from "react";
import { isSourceMarkdownEditor, openMarkdown } from "../editor/markdown-editor";
import {
  defaultProjectApiClient,
  ProjectApiError,
  type DocumentEntry,
  type DocumentList,
  type DocumentSnapshot,
  type ProjectApiClient,
  type ProjectView,
} from "../projects/api";

export interface DocumentWorkspaceProps {
  project: ProjectView;
  client?: ProjectApiClient;
}

/** File-backed document workspace. Local draft state is never treated as saved state. */
export function DocumentWorkspace({ project, client = defaultProjectApiClient }: DocumentWorkspaceProps) {
  const [documents, setDocuments] = useState<DocumentList>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>();
  const [draft, setDraft] = useState("");
  const [modeOverride, setModeOverride] = useState<"visual" | "source">();
  const [conflict, setConflict] = useState<{ currentHash?: string; message: string }>();
  const [status, setStatus] = useState("Loading documents…");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setDocuments(undefined);
    setSelectedPath(undefined);
    setSnapshot(undefined);
    setConflict(undefined);
    setError(undefined);
    setStatus("Loading documents…");
    client.listDocuments(project.id).then((result) => {
      if (cancelled) return;
      setDocuments(result);
      const first = result.documents[0]?.path;
      if (first) setSelectedPath(first);
      setStatus(first ? "Ready" : "No documents found");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(messageFor(reason));
      setStatus("Unable to load documents");
    });
    return () => { cancelled = true; };
  }, [client, project.id]);

  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    setStatus("Reading document…");
    setSnapshot(undefined);
    setConflict(undefined);
    setModeOverride(undefined);
    client.readDocument(project.id, selectedPath).then((result) => {
      if (cancelled) return;
      setSnapshot(result);
      setDraft(result.content);
      setStatus("Ready");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(messageFor(reason));
      setStatus("Unable to read document");
    });
    return () => { cancelled = true; };
  }, [client, project.id, selectedPath]);

  const editor = useMemo(() => snapshot ? openMarkdown(draft) : undefined, [draft, snapshot]);
  const detectedMode = editor?.mode ?? "visual";
  const mode = modeOverride ?? detectedMode;
  const dirty = snapshot !== undefined && draft !== snapshot.content;

  async function save() {
    if (!selectedPath || !snapshot) return;
    setStatus("Saving…");
    setError(undefined);
    try {
      const result = await client.saveDocument(project.id, selectedPath, draft, snapshot.hash);
      setSnapshot(result);
      setDraft(result.content);
      setConflict(undefined);
      setStatus("Saved to the canonical file");
    } catch (reason) {
      if (reason instanceof ProjectApiError && reason.code === "DOCUMENT_CONFLICT") {
        const currentHash = typeof reason.details?.currentHash === "string" ? reason.details.currentHash : undefined;
        setConflict({ currentHash, message: reason.message });
        setStatus("Conflict needs a decision");
      } else {
        setError(messageFor(reason));
        setStatus("Save failed");
      }
    }
  }

  async function reload() {
    if (!selectedPath) return;
    try {
      const result = await client.readDocument(project.id, selectedPath);
      setSnapshot(result);
      setDraft(result.content);
      setConflict(undefined);
      setStatus("Reloaded external changes");
    } catch (reason) {
      setError(messageFor(reason));
      setStatus("Reload failed");
    }
  }

  function keepLocal() {
    if (!conflict?.currentHash || !snapshot) return;
    setSnapshot({ ...snapshot, hash: conflict.currentHash });
    setConflict(undefined);
    setStatus("Keeping local draft; save again to overwrite the external version");
  }

  return (
    <section className="workspace" data-testid="document-workspace">
      <aside className="workspace__tree" aria-label="Document navigation">
        <div className="workspace__tree-heading"><strong>Documents</strong><span>{documents?.documents.length ?? 0}</span></div>
        <div role="list">
          {(documents?.documents ?? []).map((document) => <DocumentTreeItem key={document.path} document={document} selected={document.path === selectedPath} onSelect={() => setSelectedPath(document.path)} />)}
        </div>
      </aside>
      <section className="workspace__editor" aria-label="Document editor">
        <div className="workspace__toolbar">
          <div><span className="eyebrow">{selectedPath ?? "No selection"}</span><div data-testid="dirty-state" className={dirty ? "dirty" : "clean"}>{dirty ? "Unsaved changes" : "Saved"}</div></div>
          <div className="workspace__actions">
            {editor && <><button type="button" disabled={detectedMode === "source"} aria-pressed={mode === "visual"} onClick={() => setModeOverride("visual")}>Visual</button><button type="button" aria-pressed={mode === "source"} onClick={() => setModeOverride("source")}>Source</button></>}
            <button type="button" disabled={!dirty || Boolean(conflict)} onClick={save}>Save</button>
          </div>
        </div>
        {error && <p className="workspace__error" role="alert">{error}</p>}
        {conflict && <div className="workspace__conflict" role="alert" data-testid="document-conflict"><strong>External change detected.</strong><span>{conflict.message}</span><div><button type="button" onClick={reload}>Reload external version</button><button type="button" disabled={!conflict.currentHash} onClick={keepLocal}>Keep local draft</button></div></div>}
        {snapshot && editor ? <>
          <div className="workspace__mode" data-testid="editor-mode">{mode === "source" ? "Source fallback" : "Visual editor"}{isSourceMarkdownEditor(editor) && " · unsupported syntax preserved"}</div>
          {mode === "visual" && <div className="workspace__preview" aria-label="Visual preview">{renderPreview(draft)}</div>}
          <textarea aria-label={mode === "source" ? "Source Markdown editor" : "Visual Markdown editor"} data-testid={mode === "source" ? "source-editor" : "visual-editor"} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
        </> : <p className="workspace__status" data-testid="workspace-status">{status}</p>}
        <p className="workspace__status" aria-live="polite">{status}</p>
      </section>
    </section>
  );
}

function DocumentTreeItem({ document, selected, onSelect }: { document: DocumentEntry; selected: boolean; onSelect: () => void }) {
  return <button type="button" role="listitem" className={selected ? "document-item document-item--selected" : "document-item"} aria-current={selected ? "page" : undefined} data-testid={`document-item-${document.path}`} onClick={onSelect}>{document.path}</button>;
}

function renderPreview(source: string) {
  return source.split(/\r?\n/).map((line, index) => <p key={`${index}-${line}`}>{line.replace(/^ {0,3}#{1,6}\s+/, "") || " "}</p>);
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected document error occurred";
}
