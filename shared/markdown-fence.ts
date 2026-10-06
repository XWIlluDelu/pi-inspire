/** Preserve arbitrary source inside a fence that cannot be closed by its backticks. */
export function fencedMarkdown(content: string, language: string): string {
  let longestRun = 0;
  let run = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 96) {
      run += 1;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}
