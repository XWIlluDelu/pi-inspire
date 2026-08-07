import { Component, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/** Keep an unexpected render failure recoverable instead of leaving the local
 * workbench as an unexplained blank page. Error details remain in the browser
 * console; the UI does not expose session content or implementation internals. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-error" role="alert" aria-labelledby="app-error-title">
        <div className="app-error__card">
          <div className="app-error__eyebrow">insπre</div>
          <h1 id="app-error-title">This view could not be rendered</h1>
          <p>Reload the page to restore the workbench. The active Pi session is not modified.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </main>
    );
  }
}
