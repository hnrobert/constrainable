# constrainable-media-node

A distributed Go backend for RTMP ingest, video recording, and streaming. Each media-node pairs with an SRS sidecar container (this node owns the SRS config — template embedded, rendered to a shared volume at startup), fronts RTMP ingest with account authentication, records via SRS native DVR, and monitors via SRS HTTP API. No ffmpeg, no HTTP server — Socket.IO only.

Multiple media-nodes connect to one [constrainable-app](https://github.com/hnrobert/constrainable-app) control plane via Socket.IO, enabling horizontal scaling of ingest capacity.

## Architecture

```mermaid
graph TB
    subgraph "Control plane (constrainable-app)"
        server["server :31954<br/>auth / users / events / DB<br/>Socket.IO + node registry"]
    end
    subgraph "Media node 1"
        mn1["Go media-node<br/>:1935 RTMP ingest<br/>authmod auth dance"]
        srs1["SRS sidecar<br/>DVR recording"]
        mn1 --- srs1
    end
    subgraph "Media node N"
        mnN["Go media-node<br/>:1935 RTMP ingest"]
        srsN["SRS sidecar<br/>DVR recording"]
        mnN --- srsN
    end
    obsN["OBS"] --> mnN
    server <-->|"Socket.IO"| mn1
    server <-->|"Socket.IO"| mnN
    obs1["OBS"] --> mn1
```

## Configuration (environment)

| var | default | meaning |
| ----- | --------- | --------- |
| `API_ORIGIN` | `http://localhost:31954` | Control-plane (constrainable-app) URL — Socket.IO + auth |
| `NODE_IDENTIFIER` | `media-node` | Stable unique identity (drives nodeId: user assignments, session ownership, quotas). NOT an address. |
| `PUBLIC_NODE_ORIGIN` | _(empty)_ | THE single public origin of this node (full URL, scheme optional) — REQUIRED for multi-node deployments: browser playback is PATH-BASED on it (`${PUBLIC_NODE_ORIGIN}/live/<s>.flv`; route `/live/` on that domain to the node's published play port), and it drives latency probing + the derived OBS address. Empty in single-server deployments (users reach everything via the app's host). |
| `PUBLIC_RTMP_AUTHORITY` | _(derived)_ | OBS ingest AUTHORITY (host[:port]) for assigned users, e.g. `ingest.example.com` or `ingest.example.com:21935` when the tunnel remaps RTMP (a full `rtmp://` URL is accepted, reduced to its authority). Empty = derived from `PUBLIC_NODE_ORIGIN`'s host. |
| `NODE_IDENTIFIER` | `localhost` | This node's public identifier (reported to Node) |
| `RTMP_PORT` | `1935` | RTMP ingest port (OBS pushes here) |
| `PLAY_PORT` | `38080` | Direct playback entry — browsers pull signed FLV URLs here; every pull is authorized by the control plane over Socket.IO (`play:auth`), then proxied from the SRS sidecar |
| `SRT_PORT` | `9000` | SRT ingest port (scaffold; not yet implemented) |
| `SRS_ADDR` | `srs:1935` | RTMP relay target (docker sidecar service name; `localhost:1935` for child-process SRS) |
| `SRS_FLV_BASE` | derived from `NODE_IDENTIFIER` + `SRS_HTTP_PORT` | FLV base ADVERTISED to the control plane (how the app backend pulls playback) — set to the SRS sidecar's service name on a shared network, e.g. `http://srs:38081` |
| `SRS_API_BASE` | `http://srs:1985/api/v1` | SRS HTTP API base (docker sidecar service name; use `http://localhost:1985/api/v1` when SRS runs as a child process via `SRS_BIN`) |
| `SRS_HTTP_PORT` | `38081` | SRS sidecar http_server port — INTERNAL only, never published (the node's play port proxies it); rendered into the config and used for the `SRS_FLV_BASE` default |
| `RECORD_DIR` | `./records` | Local MKV segment storage |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary path |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary path |
| `MEDIA_NODE_AUTH_TOKEN` | _(required)_ | Shared secret with the Node control plane |
| `ALLOW_DIRECT_SRS` | `false` | Accept publishers bypassing the RTMP front-door |
| `HOSTNAME_OVERRIDE` | _(hostname)_ | Human-readable node name |

## No HTTP server

The node's only HTTP interface is the play entry (:38080 PLAY_PORT — signed URLs, auth-gated via the control plane). Everything else rides the Socket.IO connection (auth, publish lifecycle, metrics, recording reports, commands). The SRS sidecar (:38081 FLV, :1985 API) is internal-only — browsers never reach it directly, so on a shared Docker network neither of its ports needs publishing.

## Socket.IO protocol (Phase 2)

Connects to Node's `/media-nodes` namespace with `{token: MEDIA_NODE_AUTH_TOKEN}`.

**Go → Node:**

- `node:register` `{origin, rtmpPort, srtPort, hostname, version}` → ack `{nodeId}`
- `publish:start` → ack `{allow, reason, sessionId, eventId, limits, record}`
- `publish:metrics` `{sessionId, width, height, fps, bitrateKbps}`
- `publish:end` `{sessionId, endedAt, durationSec}`
- `recording:ready` `{nodeId, streamName, eventId, segments[], ...}`
- `violation` `{sessionId, reasons[], metrics}`

**Node → Go:**

- `node:kick` `{streamName, reason}`
- `recording:delete` `{recordingId, segments[]}`
- `config:limits` `{global, events:[]}`

## Run (dev)

```bash
MEDIA_NODE_AUTH_TOKEN=dev-token \
API_ORIGIN=http://localhost:31954 \
NODE_IDENTIFIER=localhost \
go run .
```

## Test

```bash
go test ./...
```

## Docker

The image bundles: Go binary + SRS + ffmpeg. One container = one media node.

```bash
docker build -t media-node .
docker compose up -d  # runs the node + its SRS sidecar (see docker-compose.yml)
```
