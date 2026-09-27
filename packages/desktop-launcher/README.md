# desktop-launcher

Go entry point (`blackhole` / `blackhole.exe`). It finds Node.js and the bundled
runtime, runs `packages/host-runtime/dist/bootstrap.cjs`, and shows an error
dialog if launching fails. No cgo, no GUI framework.

```sh
pnpm --dir packages/host-runtime build      # dist/bootstrap.cjs
pnpm build                                  # dist/cli.js (daemon)
go -C packages/desktop-launcher test ./...
go -C packages/desktop-launcher vet ./...
go -C packages/desktop-launcher build -trimpath -o bin/ ./cmd/blackhole
# Windows release: -ldflags="-H windowsgui -s -w"
```

Lookup order: `BLACKHOLE_NODE` / `BLACKHOLE_RUNTIME_DIR`, then `runtime/` next to
the executable (`node`, `bootstrap.cjs`, `daemon/cli.js`), then a source checkout
found by walking up from the executable and the working directory.
`--no-browser` starts or attaches only; `--print` writes the result as JSON.
