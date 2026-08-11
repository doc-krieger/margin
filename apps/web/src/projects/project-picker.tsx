import { useState } from "react";
import { defaultProjectApiClient, ProjectApiError, type ProjectApiClient, type ProjectView } from "./api";

export interface ProjectPickerProps {
  client?: ProjectApiClient;
  onProjectOpened?: (project: ProjectView) => void;
}

/** Local project lifecycle controls. Dangerous choices are always explicit. */
export function ProjectPicker({ client = defaultProjectApiClient, onProjectOpened }: ProjectPickerProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [pendingGitPath, setPendingGitPath] = useState<string | undefined>();
  const [pendingDuplicatePath, setPendingDuplicatePath] = useState<string | undefined>();
  const [project, setProject] = useState<ProjectView | undefined>();
  const [status, setStatus] = useState("Register a local folder before opening a project.");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<ProjectView>): Promise<void> {
    setBusy(true);
    setStatus("Working…");
    try {
      const opened = await action();
      setProject(opened);
      setPendingGitPath(undefined);
      setPendingDuplicatePath(undefined);
      setStatus(`Opened ${opened.name} (${opened.markdownFiles.length} Markdown file${opened.markdownFiles.length === 1 ? "" : "s"}).`);
      onProjectOpened?.(opened);
    } catch (error) {
      if (error instanceof ProjectApiError && error.code === "GIT_INITIALIZATION_REQUIRED") {
        setPendingGitPath(path);
        setStatus("This folder is not a Git repository. Choose how to continue.");
      } else if (error instanceof ProjectApiError && error.code === "DUPLICATE_PROJECT_IDENTITY") {
        setPendingDuplicatePath(path);
        setStatus("This folder has an identity already used at another path. Open it as a new project identity to continue.");
      } else {
        setStatus(error instanceof Error ? error.message : "Project request failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="project-panel" data-testid="project-lifecycle">
      <div className="project-panel__heading">
        <div>
          <span className="eyebrow">Project lifecycle</span>
          <h2>Open a local workspace</h2>
        </div>
        <span className="project-panel__badge">Filesystem canonical</span>
      </div>
      <p className="project-panel__status" role="status">{status}</p>
      <label>Registered root<input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/path/to/workspaces" /></label>
      <button type="button" onClick={() => client.registerRoot(rootPath).then(() => setStatus("Root registered. Choose a project folder to open.")).catch((error) => setStatus(error instanceof Error ? error.message : "Unable to register root."))} disabled={busy || !rootPath.trim()}>
        Register root
      </button>
      <div className="project-panel__fields">
        <label>Project folder<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/path/to/workspaces/my-project" /></label>
        <label>New project name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Research project" /></label>
      </div>
      <div className="project-panel__actions">
        <button type="button" onClick={() => run(() => client.openProject(path))} disabled={busy || !path.trim()}>Open existing</button>
        <button type="button" onClick={() => run(() => client.createProject({ path, name, gitDecision: "initialize" }))} disabled={busy || !path.trim()}>Create with Git</button>
        <button type="button" onClick={() => run(() => client.createProject({ path, name, gitDecision: "continue-without-git" }))} disabled={busy || !path.trim()}>Create without Git</button>
      </div>
      {pendingGitPath === path && <div className="decision-card" role="alert"><strong>Git initialization choice</strong><span>Margin will not initialize or modify Git without your confirmation.</span><div><button type="button" onClick={() => run(() => client.openProject(path, { gitDecision: "initialize" }))}>Initialize Git</button><button type="button" onClick={() => run(() => client.openProject(path, { gitDecision: "continue-without-git" }))}>Continue without Git</button></div></div>}
      {pendingDuplicatePath === path && <div className="decision-card" role="alert"><strong>Duplicate project identity</strong><span>Assign a fresh identity before registering this folder.</span><button type="button" onClick={() => run(() => client.openProject(path, { duplicateIdentityDecision: "assign-new-id", gitDecision: "continue-without-git" }))}>Assign new identity</button></div>}
      {project && <div className="project-panel__result"><strong>{project.name}</strong><span>{project.path}</span><span>{project.files.length} files · {project.gitInitialized ? "Git enabled" : "Git not initialized"}</span></div>}
    </section>
  );
}
