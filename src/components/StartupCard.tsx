import type { ReactNode } from "react";
import { BrandLogo, Wordmark } from "./Wordmark";

export function StartupCard({
  title,
  hint,
  children,
  role,
}: {
  title: string;
  hint: string;
  children: ReactNode;
  role?: "alert";
}) {
  return (
    <div className="token-gate" role={role}>
      <div className="token-gate__card">
        <div className="token-gate__lockup">
          <BrandLogo size={28} />
          <Wordmark large />
        </div>
        <div>
          <h1 className="token-gate__title">{title}</h1>
          <p className="token-gate__hint">{hint}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
