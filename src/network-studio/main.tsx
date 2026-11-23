import { StrictMode, Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import NetworkStudio from "./NetworkStudio.tsx";

class StudioBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Do not log imported workspace data. */
  }
  render() {
    return this.state.failed ? (
      <main style={{ padding: 40, color: "#e5e7eb" }}>
        <h1>The workspace could not be displayed.</h1>
        <p>Your last saved browser workspace has been kept. Reload to retry.</p>
        <button onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudioBoundary>
      <NetworkStudio />
    </StudioBoundary>
  </StrictMode>,
);
