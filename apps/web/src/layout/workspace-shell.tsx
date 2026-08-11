import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export const workspacePaneOrder = ["documents", "editor", "comments", "runs", "history"] as const;
export type WorkspacePaneId = (typeof workspacePaneOrder)[number];
export type PaneDirection = "next" | "previous";

export interface WorkspaceCapabilities {
  canRead: boolean;
  canComment: boolean;
  canEdit: boolean;
  canRun: boolean;
  canRestore: boolean;
}

export function getWorkspaceCapabilities(isMobile: boolean): WorkspaceCapabilities {
  return {
    canRead: true,
    canComment: true,
    canEdit: !isMobile,
    canRun: !isMobile,
    canRestore: !isMobile,
  };
}

export function visibleWorkspacePanes(isMobile: boolean): WorkspacePaneId[] {
  return isMobile ? ["documents", "editor", "comments"] : [...workspacePaneOrder];
}

export function nextWorkspacePane(
  current: WorkspacePaneId,
  direction: PaneDirection,
  isMobile = false,
): WorkspacePaneId {
  const panes = visibleWorkspacePanes(isMobile);
  const currentIndex = panes.indexOf(current);
  const offset = direction === "next" ? 1 : -1;
  return panes[(currentIndex + offset + panes.length) % panes.length];
}

/** Read the viewport once on mount and keep the mobile safety boundary in sync. */
export function useWorkspaceViewport(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 42rem)");
    const update = () => setIsMobile(query.matches);
    update();
    if (query.addEventListener) {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  return isMobile;
}

export interface WorkspaceShellProps {
  projectName: string;
  status?: string;
  error?: string;
  isMobile?: boolean;
  children: ReactNode;
}

export interface WorkspacePaneProps {
  id: WorkspacePaneId;
  title: string;
  className?: string;
  children: ReactNode;
}

/** A labelled landmark shared by every desktop workspace surface. */
export function WorkspacePane({ id, title, className, children }: WorkspacePaneProps) {
  return (
    <section
      id={`workspace-pane-${id}`}
      className={className ? `workspace-pane ${className}` : "workspace-pane"}
      data-workspace-pane={id}
      role="region"
      aria-labelledby={`workspace-pane-title-${id}`}
      tabIndex={0}
    >
      <h2 id={`workspace-pane-title-${id}`} className="sr-only">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Workspace-level navigation owns pane focus, status announcements, and the
 * responsive capability boundary; feature panels remain responsible for their
 * own API state and error details.
 */
export function WorkspaceShell({ projectName, status, error, isMobile = false, children }: WorkspaceShellProps) {
  const [activePane, setActivePane] = useState<WorkspacePaneId>("editor");
  const tabRefs = useRef<Partial<Record<WorkspacePaneId, HTMLButtonElement>>>({});
  const panes = visibleWorkspacePanes(isMobile);
  const capabilities = getWorkspaceCapabilities(isMobile);

  useEffect(() => {
    if (!visibleWorkspacePanes(isMobile).includes(activePane)) setActivePane("editor");
  }, [activePane, isMobile]);

  function focusPane(pane: WorkspacePaneId) {
    setActivePane(pane);
    if (typeof document === "undefined") return;
    window.requestAnimationFrame(() => document.getElementById(`workspace-pane-${pane}`)?.focus());
  }

  function handlePaneKeyDown(event: KeyboardEvent<HTMLButtonElement>, pane: WorkspacePaneId) {
    let next: WorkspacePaneId | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = nextWorkspacePane(pane, "next", isMobile);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = nextWorkspacePane(pane, "previous", isMobile);
    if (event.key === "Home") next = panes[0];
    if (event.key === "End") next = panes[panes.length - 1];
    if (!next) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
    focusPane(next);
  }

  return (
    <section
      className="workspace-shell"
      data-testid="workspace-shell"
      data-viewport={isMobile ? "mobile" : "desktop"}
      data-mobile-readonly={isMobile ? "true" : "false"}
      data-active-pane={activePane}
      aria-label={`${projectName} workspace`}
    >
      <a className="skip-link" href="#workspace-main">Skip to workspace content</a>
      <header className="workspace-shell__header">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>{projectName}</h2>
        </div>
        <div className="workspace-shell__status-group">
          <span className="workspace-shell__capability" data-testid="workspace-capability">
            {capabilities.canEdit ? "Full editing" : "Read and comment only"}
          </span>
          <span className="workspace-shell__state" data-testid="workspace-state" role="status" aria-live="polite">
            {status ?? "Workspace ready"}
          </span>
        </div>
      </header>
      {isMobile && (
        <p className="workspace-shell__mobile-notice" role="status">
          Mobile mode is read and comment only. Editing, runs, and restores are available on desktop.
        </p>
      )}
      {error && <p className="workspace-shell__error" data-testid="workspace-error" role="alert">{error}</p>}
      <nav className="workspace-shell__navigation" aria-label="Workspace panes">
        <div role="tablist" aria-label="Workspace panes" aria-orientation="horizontal">
          {panes.map((pane) => (
            <button
              key={pane}
              ref={(element) => { if (element) tabRefs.current[pane] = element; }}
              id={`workspace-tab-${pane}`}
              type="button"
              role="tab"
              aria-controls={`workspace-pane-${pane}`}
              aria-selected={activePane === pane}
              tabIndex={activePane === pane ? 0 : -1}
              data-testid={`workspace-pane-tab-${pane}`}
              onClick={() => focusPane(pane)}
              onKeyDown={(event) => handlePaneKeyDown(event, pane)}
            >
              {pane === "documents" ? "Documents" : pane[0].toUpperCase() + pane.slice(1)}
            </button>
          ))}
        </div>
      </nav>
      <div id="workspace-main" className="workspace-shell__panes">
        {children}
      </div>
    </section>
  );
}

export function renderMarkdownPreview(source: string) {
  return source.split(/\r?\n/).map((line, index) => (
    <p key={`${index}-${line}`}>{line.replace(/^ {0,3}#{1,6}\s+/, "") || " "}</p>
  ));
}
