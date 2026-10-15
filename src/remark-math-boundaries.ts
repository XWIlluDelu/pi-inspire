/*!
 * Dollar tokenizer adapted from micromark-extension-math-extended.
 *
 * (The MIT License)
 *
 * Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
 * Copyright (c) 2025-2026 Jerry <jerrynh770@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * 'Software'), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";

const digit = (code: number | null) =>
  code !== null && code >= 48 && code <= 57;
const word = (code: number | null) =>
  code !== null &&
  (digit(code) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95);
const lineEnding = (code: number | null) =>
  code === -5 || code === -4 || code === -3;
// Negative micromark codes are line endings, tabs and virtual spaces.
const whitespace = (code: number | null) =>
  code !== null && (code < 0 || /\s/u.test(String.fromCodePoint(code)));

/** Keep the upstream math AST/resolver and all block/backslash constructs.
 * Dollar text needs escaped-delimiter parity and lexical boundaries: regex or
 * string endings cannot open math; a dollar starting a number cannot close it;
 * whitespace/path separators followed by an identifier continue literal text.
 * Reject in the tokenizer, before prose/links/emphasis can be swallowed. */
export const remarkMathDelimiterBoundaries: Plugin<[], Root> = function () {
  for (const extension of this.data().micromarkExtensions ?? []) {
    const dollar = extension.text?.[36];
    for (const construct of Array.isArray(dollar)
      ? dollar
      : dollar
        ? [dollar]
        : []) {
      if (construct.name !== "mathText") continue;
      construct.tokenize = function (effects, ok, nok) {
        type State = typeof ok;
        let opening = 0;
        let closing = 0;
        let slashRun = 0;
        let previous: number | null = null;
        let beforeClose: number | null = null;
        let sequence: ReturnType<typeof effects.enter>;

        const start: State = (code) => {
          effects.enter("mathText");
          effects.enter("mathTextSequence");
          return open(code);
        };
        const open: State = (code) => {
          if (code === 36) {
            opening++;
            effects.consume(code);
            return open;
          }
          if (opening === 1 && (code === 47 || code === 34 || code === 39))
            return nok(code);
          effects.exit("mathTextSequence");
          return between(code);
        };
        const between: State = (code) => {
          if (code === null) return nok(code);
          if (code === 36) {
            beforeClose = previous;
            sequence = effects.enter("mathTextSequence");
            closing = 0;
            return close(code);
          }
          if (code === 32 || lineEnding(code)) {
            const type = code === 32 ? "space" : "lineEnding";
            effects.enter(type);
            effects.consume(code);
            effects.exit(type);
            previous = code;
            slashRun = 0;
            return between;
          }
          effects.enter("mathTextData");
          return data(code);
        };
        const data: State = (code) => {
          const escapedDollar = code === 36 && slashRun % 2 === 1;
          if (
            code === null ||
            code === 32 ||
            lineEnding(code) ||
            (code === 36 && !escapedDollar)
          ) {
            effects.exit("mathTextData");
            return between(code);
          }
          effects.consume(code);
          previous = code;
          slashRun = code === 92 ? slashRun + 1 : 0;
          return data;
        };
        const close: State = (code) => {
          if (code === 36) {
            closing++;
            effects.consume(code);
            return close;
          }
          if (closing === opening) {
            if (
              opening === 1 &&
              (digit(code) ||
                ((word(code) || code === 123 || code === 40) &&
                  (whitespace(beforeClose) ||
                    beforeClose === 47 ||
                    beforeClose === 58)))
            )
              return nok(code);
            effects.exit("mathTextSequence");
            effects.exit("mathText");
            return ok(code);
          }
          sequence.type = "mathTextData";
          previous = 36;
          slashRun = 0;
          return data(code);
        };
        return start;
      };
    }
  }
};
