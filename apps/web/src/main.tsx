import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return <main><h1>Margin</h1><p>Local-first document workspace</p><span data-testid="service-status">Ready for local projects</span></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
