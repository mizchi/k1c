# k1c wasm component WIT

This directory holds the WIT world spec for the wasm component build
(`scripts/build-wasm.mjs`). The world re-exports `wasi:cli/run@0.2.0`
so the resulting component is runnable under any wasi-cli host
(wasmtime, jco run, runwasi, etc.).

The wasi-cli, wasi-io, wasi-clocks, wasi-filesystem, wasi-random and
wasi-sockets WIT packages are NOT vendored here — they need to be
copied from a wasi-spec release (or a `wit-deps` lock) into
`wit/deps/<package>/...` before componentize-js can resolve the
include in `world.wit`.

```sh
# Example using wit-deps:
wit-deps update --manifest wit/deps.toml
```

Once the deps are present, `pnpm build:wasm` produces
`dist-wasm/k1c.wasm`. The bundle at `dist-wasm/k1c.bundle.mjs` is
emitted unconditionally and can be re-componentized out-of-band.
