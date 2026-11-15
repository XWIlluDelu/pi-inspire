import { store, useAppState } from "../store";
import { BuffonNeedles } from "./BuffonNeedles";
import { BrandLogo, Wordmark } from "./Wordmark";

/** Browser-owned controls remain native; this is only the overlay's drag surface. */
export function WindowTitlebar() {
  const needlesActive = useAppState(
    (state) =>
      state.desiredPreferences.titlebarNeedles ?? state.prefs.titlebarNeedles,
  );
  return (
    <div className="window-titlebar">
      {needlesActive ? <BuffonNeedles /> : null}
      <div className="window-titlebar__safe">
        <div className="window-titlebar__corner-logo" aria-hidden="true">
          <BrandLogo size={16} />
        </div>
        <button
          type="button"
          className="window-titlebar__brand-button"
          onClick={() => store.setPreference("titlebarNeedles", !needlesActive)}
          aria-label="Inspire — Buffon's needles"
          aria-pressed={needlesActive}
          title={
            needlesActive
              ? "Buffon's needles (active) — click to disable"
              : "Buffon's needles — click to toggle"
          }
        >
          <Wordmark />
        </button>
      </div>
    </div>
  );
}
