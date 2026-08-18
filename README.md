# media-node

A distributed Go backend for RTMP ingest, video recording, and streaming. Each media-node instance is self-contained: it runs a colocated SRS media server, fronts RTMP ingest with account authentication, records streams in real time, probes for compliance, and serves video directly to browsers.

Multiple media-nodes connect to one Node (Nuxt) control plane via Socket.IO, enabling horizontal scaling of ingest capacity.

## Architecture

```
Node control plane (:31954)
  ├── auth / users / events / DB
  ├── Socket.IO server (/media-nodes namespace)
  └── media-node registry (routes viewers to the right node)

Media node 1 (:1935 RTMP)     Media node 2 ...
  ├── RTMP ingest (authmod auth dance)       ├── ...
  ├── Colocated SRS (managed by this node)
  ├── ffmpeg recorder (real-time MKV)
  ├── ffprobe compliance checker
  └── (no HTTP — socket only)
```

## Configuration (environment)

| var | default | meaning |
|-----|---------|---------|
| `NODE_ORIGIN` | `http://localhost:31954` | Node control plane URL (socket.io + auth HTTP) |
| `SELF_ORIGIN` | `localhost` | This node's public identifier (reported to Node) |
| `RTMP_PORT` | `1935` | RTMP ingest port (OBS pushes here) |
| `SRT_PORT` | `9000` | SRT ingest port (scaffold; not yet implemented) |
| `SRS_ADDR` | `localhost:1935` | Colocated SRS RTMP relay target |
| `SRS_FLV_BASE` | `http://localhost:8080` | SRS HTTP-FLV base for pulls |
| `SRS_API_BASE` | `http://localhost:1985/api/v1` | SRS HTTP API base |
| `RECORD_DIR` | `./records` | Local MKV segment storage |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary path |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary path |
| `MEDIA_NODE_AUTH_TOKEN` | _(required)_ | Shared secret with the Node control plane |
| `ALLOW_DIRECT_SRS` | `false` | Accept publishers bypassing the RTMP front-door |
| `HOSTNAME_OVERRIDE` | _(hostname)_ | Human-readable node name |

## No HTTP server

The media-node exposes NO HTTP interface. All communication with the Node control plane rides the Socket.IO connection (auth, publish lifecycle, metrics, recording reports, commands). Browsers access video directly from the colocated SRS (:8080 FLV, :1985 API).

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
docker run -e NODE_ORIGIN=http://host:31954 -e MEDIA_NODE_AUTH_TOKEN=... -p 1935:1935 media-node
```
