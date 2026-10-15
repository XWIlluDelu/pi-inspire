/** Ordinary technical/prose syntax that must not become mathematical content. */
export const richTextLiteralCases = [
  ["currency", "Budget $5 per call, $10 total."],
  ["decimal amounts", "Prices range from $5.00–$10.00."],
  ["variables", "Read $HOME and $PATH before starting."],
  ["variable whitespace", "Compare $HOME\t$PATH and $ROOT\u00a0$APP."],
  ["variable paths", "Read $HOME/.config/$APP/config.json."],
  ["braced variables", "Read ${HOME}/${APP}/config.json."],
  ["command substitution", "Save to $HOME/$(date)/report.txt."],
  ["search paths", "Set PATH=$HOME/bin:$PATH."],
  ["quoted regex", String.raw`Use '^\d+$' rather than '^(0|[1-9]\d*)$'.`],
  [
    "double quoted regex",
    String.raw`Use "^\d+$" rather than "^(0|[1-9]\d*)$".`,
  ],
  ["bare regex", String.raw`Use /^\d+$/ rather than /^(0|[1-9]\d*)$/.`],
  ["generic types", "Types: Array<T> and Promise<Result<T>>."],
] as const;

export const literalReviewText = richTextLiteralCases
  .map(([, source]) => source)
  .join("\n\n");
export const escapedCurrencyMath = String.raw`\text{Cost: \$5}`;
export const wideInlineMath =
  String.raw`\begin{pmatrix}` +
  Array.from({ length: 18 }, (_, i) => `x_{${i + 1}}`).join("&") +
  String.raw`\end{pmatrix}`;
