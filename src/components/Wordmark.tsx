interface BrandLogoProps {
  size?: number;
  className?: string;
}

/** Open Reticle precision geometric brand logo.
 * Opposing ink brackets orbit four accent datum ticks and a square aperture.
 * The micro and display masters preserve the same clear-space rhythm while
 * compensating stroke weight independently at small sizes. */
export function BrandLogo({ size = 20, className = "" }: BrandLogoProps) {
  if (size < 24) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`brand-logo ${className}`}
        aria-hidden="true"
      >
        {/* Open frame: top-right and bottom-left */}
        <path
          d="M10.25 2.75H13.25V5.75M5.75 13.25H2.75V10.25"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
        {/* Four detached datum ticks leave a deliberate clear-space ring. */}
        <path
          d="M8 1.5V3.75M8 12.25V14.5M1.5 8H3.75M12.25 8H14.5"
          stroke="var(--brand-accent)"
          strokeWidth="1.25"
          strokeLinecap="square"
        />
        {/* Center precision aperture square */}
        <rect x="7" y="7" width="2" height="2" fill="var(--brand-accent)" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`brand-logo ${className}`}
      aria-hidden="true"
    >
      {/* Top-right and bottom-left brackets define the outer orbit. */}
      <path
        d="M15.25 4.25H19.75V9M8.75 19.75H4.25V15"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {/* Detached datum ticks preserve an open field around the aperture. */}
      <path
        d="M12 2.25V5.5M12 18.5V21.75M2.25 12H5.5M18.5 12H21.75"
        stroke="var(--brand-accent)"
        strokeWidth="1.75"
        strokeLinecap="square"
      />
      {/* Center precision aperture square */}
      <rect x="10.5" y="10.5" width="3" height="3" fill="var(--brand-accent)" />
    </svg>
  );
}

/** The INSΠRE brand mark — an engineered, high-end technical wordmark. */
export function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <span
      className={`wordmark ${large ? "wordmark--large" : ""}`}
      role="img"
      aria-label="Inspire"
    >
      <span className="wordmark__text" aria-hidden="true">
        <span className="wordmark__lead">INS</span>
        <span className="wordmark__pi">Π</span>
        <span className="wordmark__tail">RE</span>
      </span>
    </span>
  );
}
