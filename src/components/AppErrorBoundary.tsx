import type { ReactNode } from "react";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { StartupCard } from "./StartupCard";

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <RenderErrorBoundary
      fallback={
        <StartupCard
          role="alert"
          title="The workbench hit an error"
          hint="Refresh the page. Any running Pi session continues."
        >
          <button
            type="button"
            className="button button--primary"
            onClick={() => window.location.reload()}
          >
            Refresh page
          </button>
        </StartupCard>
      }
    >
      {children}
    </RenderErrorBoundary>
  );
}
