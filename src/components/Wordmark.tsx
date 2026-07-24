/** The insπre brand mark — the one authority for its markup. Styling lives
 * in the `.wordmark` CSS (italic serif, math-italic π). */
export function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <span className={`wordmark ${large ? "wordmark--large" : ""}`}>
      ins<em>π</em>re
    </span>
  );
}
