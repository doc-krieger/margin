import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectPicker } from "./projects/project-picker";
import type { ProjectView } from "./projects/api";
import "./styles.css";

function App() {
  const [project, setProject] = useState<ProjectView>();
  return (
    <main>
      <header className="app-header"><div><span className="eyebrow">Local-first workspace</span><h1>Margin</h1></div><span data-testid="service-status">{project ? `Working in ${project.name}` : "Ready for local projects"}</span></header>
      <p className="app-intro">Open a folder, keep its files canonical, and make every identity or Git change explicit.</p>
      <ProjectPicker onProjectOpened={setProject} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
