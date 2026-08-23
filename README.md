# constrainable

Live-proctoring / contest ingest platform. Monorepo merged from
[constrainable-app](https://github.com/hnrobert/constrainable-app) (Nuxt 4 /
Nitro / Bun) and
[constrainable-media-node](https://github.com/hnrobert/constrainable-media-node)
(Go RTMP gateway + SRS sidecar) — full git history preserved via `git subtree`
under `app/` and `node/`.

## Layout

```text
proto/   control.v1 protobuf schema (single source of truth) + buf configs
app/     Nuxt 4 / Nitro ingest app (Bun)
node/    Go media node: RTMP gateway, STUN probe, WebSocket control client
```

## Proto codegen (buf)

One-time setup:

```bash
bun install                                                   # buf + protoc-gen-es at the root
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
```

After cloning (before the first `go build` / `bun run typecheck`) and after
editing anything under `proto/`:

```bash
bun run proto          # regenerate node/gen + app/shared/proto (NOT committed)
bun run proto:lint     # buf lint (STANDARD)
```

Generated code is never committed (gitignored). CI regenerates it before the
tests and Docker builds of both images.

## Local development notes

- The media-node control WebSocket (`/ws/media-node`) needs a built server or
  docker compose — the Nuxt dev server sits behind the Vite proxy, which does
  not forward WS upgrades. Run the built app and point the node's `API_ORIGIN`
  at it:

  ```bash
  cd app && bun run build && bun .output/server/index.mjs
  ```

- Deployment (NAS) pulls prebuilt images from GHCR; image names are unchanged
  from the pre-merge repos: `ghcr.io/hnrobert/constrainable-app`,
  `ghcr.io/hnrobert/constrainable-media-node`.
