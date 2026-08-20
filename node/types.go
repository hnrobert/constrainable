// Package node: Socket.IO client connecting this media node to the Node control
// plane. Handles registration, publish authorization (ack-based), event
// reporting (metrics/end/recording), and command reception (kick/config/delete).
package node

// RegisterPayload is what a media node sends on (re)connect to identify itself.
type RegisterPayload struct {
	Identifier         string `json:"identifier"`         // NODE_IDENTIFIER — the stable identity (nodeId source)
	RTMPPort           int    `json:"rtmpPort"`           // RTMP ingest port
	PublicOrigin       string `json:"publicOrigin"`       // public hostname/IP ("" = users push via the app's host)
	PublicRTMPPort     int    `json:"publicRtmpPort"`     // publicly mapped RTMP ingest port
	PublicProbeUDPPort int    `json:"publicProbeUdpPort"` // publicly mapped STUN probe responder port
	PublicSrsUDPPort   int    `json:"publicSrsUdpPort"`   // publicly mapped SRS WebRTC UDP (media) port
	SRSFlvBase         string `json:"srsFlvBase"`         // how the control plane pulls FLV from this node's SRS
	Hostname           string `json:"hostname"`           // human-readable name
	Version            string `json:"version"`            // media-node binary version
}

// WhepRelay is the control plane's request to relay one WHEP (WebRTC
// playback) SDP exchange through this node to its colocated SRS — the node's
// SRS HTTP API is never published, so the app cannot reach it directly.
type WhepRelay struct {
	StreamName string `json:"streamName"`
	Offer      string `json:"offer"`
}

// RegisteredAck is Node's response to a successful registration.
type RegisteredAck struct {
	NodeID string `json:"nodeId"`
}

// PublishStart is sent when a publisher's stream starts (relay succeeded or
// SRS hook for direct publishers). Node responds with an ack carrying the
// authorization decision + session assignment.
type PublishStart struct {
	NodeID      string `json:"nodeId"`
	StreamName  string `json:"streamName"`  // the synthesized stream name (email or ip-…)
	Token       string `json:"token"`       // the event key the publisher used
	AuthedUser  string `json:"authedUser"`  // the authenticated account email ("" if unauthenticated)
	SRSClientID string `json:"srsClientId"` // SRS client id for kick commands
}

// PublishAuthorized is Node's ack to publish:start — the authorization decision
// plus everything the node needs to run the session.
type PublishAuthorized struct {
	Allow     bool    `json:"allow"`
	Reason    string  `json:"reason,omitempty"`
	SessionID int64   `json:"sessionId,omitempty"`
	EventID   *int64  `json:"eventId,omitempty"`
	Limits    *Limits `json:"limits,omitempty"`
	Record    bool    `json:"record"`
	Strict    bool    `json:"strict"`
	Measured  bool    `json:"measured"`
}

// Limits mirrors the Node config's per-event / global stream caps.
type Limits struct {
	MaxWidth       int `json:"maxWidth"`
	MaxHeight      int `json:"maxHeight"`
	MaxFps         int `json:"maxFps"`
	MaxBitrateKbps int `json:"maxBitrateKbps"`
}

// MetricsReport carries periodic probe results for one session.
type MetricsReport struct {
	SessionID   int64   `json:"sessionId"`
	Width       int     `json:"width,omitempty"`
	Height      int     `json:"height,omitempty"`
	Fps         float64 `json:"fps,omitempty"`
	BitrateKbps int     `json:"bitrateKbps,omitempty"`
}

// EndReport signals a stream ended and carries the final duration.
type EndReport struct {
	SessionID   int64 `json:"sessionId"`
	EndedAt     int64 `json:"endedAt"`     // epoch ms
	DurationSec int   `json:"durationSec"` // wall-clock stream duration
}

// RecordingSegment describes one on-disk MKV file within a recording.
type RecordingSegment struct {
	RelPath     string `json:"relPath"`
	SizeBytes   int64  `json:"sizeBytes"`
	DurationSec int    `json:"durationSec"`
}

// RecordingReady reports that a recording segment was finalized on disk.
type RecordingReady struct {
	NodeID      string             `json:"nodeId"`
	StreamName  string             `json:"streamName"`
	EventID     *int64             `json:"eventId"`
	SessionID   int64              `json:"sessionId,omitempty"`
	Segments    []RecordingSegment `json:"segments"`
	SizeBytes   int64              `json:"sizeBytes"`
	DurationSec int                `json:"durationSec"`
	AvgFps      float64            `json:"avgFps,omitempty"`
	Width       int                `json:"width,omitempty"`
	Height      int                `json:"height,omitempty"`
}

// ViolationReport signals a limits violation mid-stream.
type ViolationReport struct {
	SessionID int64          `json:"sessionId"`
	Reasons   []string       `json:"reasons"`
	Metrics   *MetricsReport `json:"metrics,omitempty"`
}

// --- Node → Go commands ---

// PlayAuth asks the control plane to authorize a DIRECT browser FLV pull.
// The signature was minted by the app (admin-gated /api/streams/url); the
// app verifies it — the node never holds the secret.
type PlayAuth struct {
	Stream string `json:"stream"`
	Exp    int64  `json:"exp"`
	Sig    string `json:"sig"`
}

// PlayAuthAck is the control plane's verdict on a direct pull.
type PlayAuthAck struct {
	Allow  bool   `json:"allow"`
	Reason string `json:"reason,omitempty"`
}

// PublishSpec is OBS' DECLARED encoder configuration from onMetaData —
// arrives right after publish accepts, before the first frame. Instant spec
// for display + immediate limit gating; measured counters stay authoritative.
type PublishSpec struct {
	NodeID     string  `json:"nodeId"`
	StreamName string  `json:"streamName"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Fps        float64 `json:"fps"`
	VideoKbps  float64 `json:"videoKbps"`
	AudioKbps  float64 `json:"audioKbps"`
}

// SpecVerdict is the control plane's decision on a declared spec: Allow
// false → the RTMP handler rejects the publisher OBS-terminally (BadName),
// exactly like a wrong password. No ban is implied — fixing the encoder
// settings and reconnecting is the only remedy needed.
type SpecVerdict struct {
	Allow  bool   `json:"allow"`
	Reason string `json:"reason,omitempty"`
}

// NodeKick tells this node to disconnect a publisher.
type NodeKick struct {
	StreamName string `json:"streamName"`
	Reason     string `json:"reason,omitempty"`
}

// RecordingDelete tells this node to remove recording segment files.
type RecordingDelete struct {
	RecordingID int64    `json:"recordingId"`
	Segments    []string `json:"segments"`
}

// ConfigLimits pushes hot-reloaded limits (global + per-event overrides).
type ConfigLimits struct {
	Global Limits        `json:"global"`
	Events []EventLimits `json:"events"`
}

// EventLimits is a per-event override entry.
type EventLimits struct {
	EventID int64  `json:"eventId"`
	Limits  Limits `json:"limits"`
}
