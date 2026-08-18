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
| `NODE_ORIGIN` | `http://localhost:31954` | Node control plane URL (socket.io + auth HTTP) |
| `SELF_ORIGIN` | `localhost` | This node's public identifier (reported to Node) |
| `RTMP_PORT` | `1935` | RTMP ingest port (OBS pushes here) |
| `SRT_PORT` | `9000` | SRT ingest port (scaffold; not yet implemented) |
| `SRS_ADDR` | `localhost:1935` | Colocated SRS RTMP relay target |
| `SRS_FLV_BASE` | derived from `SELF_ORIGIN` + `SRS_HTTP_PORT` | FLV base ADVERTISED to the control plane (how the app backend pulls playback) — set to the Docker service name on a shared network, e.g. `http://media-node:38080` |
| `SRS_API_BASE` | `http://localhost:1985/api/v1` | SRS HTTP API base |
| `SRS_HTTP_PORT` | `38080` | SRS http_server (FLV) port — rendered into the config and used for the `SRS_FLV_BASE` default |
| `RECORD_DIR` | `./records` | Local MKV segment storage |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary path |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary path |
| `MEDIA_NODE_AUTH_TOKEN` | _(required)_ | Shared secret with the Node control plane |
| `ALLOW_DIRECT_SRS` | `false` | Accept publishers bypassing the RTMP front-door |
| `HOSTNAME_OVERRIDE` | _(hostname)_ | Human-readable node name |

## No HTTP server

The media-node exposes NO HTTP interface of its own. All communication with the Node control plane rides the Socket.IO connection (auth, publish lifecycle, metrics, recording reports, commands). The SRS sidecar (:38080 FLV, :1985 API) is reached only by the control plane over the internal network — viewers play through the app's same-origin proxy, so on a shared Docker network neither port needs publishing.

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
NODE_ORIGIN=http://localhost:31954 \
SELF_ORIGIN=localhost \
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
