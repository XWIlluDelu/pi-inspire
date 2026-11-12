# Flux Mono SC

This web bundle uses version `0.100`, built by the font project's
`tools/build_web.py`. The stylesheet records each shard's Unicode ranges.
[`SHA256SUMS`](flux-mono-sc/SHA256SUMS) records the distributed file hashes.

The build assigns public zero- and one-cell mappings to `core`. It assigns
two-cell mappings to the first matching official IBM Plex Sans SC 1.1.0 bucket
and combines four ordered buckets per shard. `wide-extra` contains the remaining
public two-cell mappings.

| Source input | SHA-256 |
| --- | --- |
| `policies/regular-widths.tsv` | `a64791db9734a6c9f7589ad5233b426e6d7651ea4b280046d3433b11d50e52fb` |
| `policies/web-shards.json` | `6693796b956dd8df142269b5877a79354adb56c6165a5923e980321a46bd6b15` |
| `artifacts/regular/FluxMonoSC-Regular.ttf` | `f6e7f6fc28ceb85879702cbdf2a23221201ae20793dd1f2c25c789e3162f6687` |
| `artifacts/medium/FluxMonoSC-Medium.ttf` | `8c4678626804040cc550fe3b18b0f62a05ffd6aeac1c030876377acd9a4327bb` |
