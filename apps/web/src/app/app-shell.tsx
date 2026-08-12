import { useState } from "react";
import { DocumentWorkspace } from "../workspace";
import { ProjectPicker } from "../projects/project-picker";
import { defaultProjectApiClient, type ProjectApiClient, type ProjectView } from "../projects/api";

export interface AppShellProps {
  client?: ProjectApiClient;
}

/** Coordinates project selection with exactly one mounted document workspace. */
export function AppShell({ client = defaultProjectApiClient }: AppShellProps) {
  const [project, setProject] = useState<ProjectView>();
  const proposalId = new URLSearchParams(window.location.search).get("proposal") ?? undefined;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">Local-first workspace</span>
          <h1>Margin</h1>
        </div>
        <span data-testid="service-status" role="status" aria-live="polite">
          {project ? `Working in ${project.name}` : "Ready for local projects"}
        </span>
      </header>
      <p className="app-intro">Open a folder, keep its files canonical, and review every proposed change before it reaches the project.</p>
      {!project && <ProjectPicker client={client} onProjectOpened={setProject} />}
      {project && <DocumentWorkspace project={project} client={client} proposalId={proposalId} />}
    </main>
  );
}
