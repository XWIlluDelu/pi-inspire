# License overrides

These texts are embedded into the generated browser-bundle notices only when an npm package declares a license but omits its license file.

- `earendil-works-pi-MIT.txt`: `@earendil-works/pi-tui@1.3.0`, verified against the upstream `v1.3.0` tag at [`71023aec1546d6d677a65669c5665c0927ce0dd0`](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/LICENSE). The MIT text is unchanged from the previously reviewed version.
- `rehype-katex-MIT.txt`: `rehype-katex@7.0.1`, copied from the package's npm `gitHead` [`88a9497e1ede93b958237c85edbf5651faeca7af`](https://github.com/remarkjs/remark-math/blob/88a9497e1ede93b958237c85edbf5651faeca7af/license).

A newly bundled package without its own license text fails the Vite build. Add an override only after verifying the exact published source revision and recording it here.
