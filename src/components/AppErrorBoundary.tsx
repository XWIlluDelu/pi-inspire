import type { ReactNode } from "react";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

/** Keep an unexpected render failure recoverable instead of leaving the local
 * workbench as an unexplained blank page. Error details remain in the browser
 * console; the UI does not expose session content or implementation internals. */
export function AppErrorBoundary({ children }: AppErrorBoundaryProps) {
  return (
    <RenderErrorBoundary
      fallback={
        <main
          className="app-error"
          role="alert"
          aria-labelledby="app-error-title"
        >
          <div className="app-error__card">
            <div className="app-error__eyebrow">INSΠRE</div>
            <h1 id="app-error-title">This view could not be rendered</h1>
            <p>
              Reload the page to restore the workbench. The active Pi session is
              not modified.
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </main>
      }
    >
      {children}
    </RenderErrorBoundary>
  );
}
