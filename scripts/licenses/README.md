# License overrides

These texts are embedded into the generated browser-bundle notices only when an npm package declares a license but omits its license file.

- `earendil-works-pi-MIT.txt`: `@earendil-works/pi-tui@0.84.4`, copied from the package's npm `gitHead` [`b79e4cc834970cca69daebffab7df1da7d1e52c4`](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/LICENSE).
- `rehype-katex-MIT.txt`: `rehype-katex@7.0.1`, copied from the package's npm `gitHead` [`88a9497e1ede93b958237c85edbf5651faeca7af`](https://github.com/remarkjs/remark-math/blob/88a9497e1ede93b958237c85edbf5651faeca7af/license).

A newly bundled package without its own license text fails the Vite build. Add an override only after verifying the exact published source revision and recording it here.
