// Package node: Socket.IO client connecting this media node to the Node control
// plane. Handles registration, publish authorization (ack-based), event
// reporting (metrics/end/recording), and command reception (kick/config/delete).
package node

// RegisterPayload is what a media node sends on (re)connect to identify itself.
type RegisterPayload struct {
	Origin     string `json:"origin"`     // this node's public HTTP origin (SELF_ORIGIN)
	RTMPPort   int    `json:"rtmpPort"`   // RTMP ingest port
	SRTPort    int    `json:"srtPort"`    // SRT ingest port (scaffold)
	SRSFlvBase string `json:"srsFlvBase"` // how the control plane pulls FLV from this node's SRS
	Hostname   string `json:"hostname"`   // human-readable name
	Version    string `json:"version"`    // media-node binary version
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
	Allow     bool   `json:"allow"`
	Reason    string `json:"reason,omitempty"`
	SessionID int64  `json:"sessionId,omitempty"`
	EventID   *int64 `json:"eventId,omitempty"`
	Limits    *Limits `json:"limits,omitempty"`
	Record    bool   `json:"record"`
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
	RelPath string  `json:"relPath"`
	SizeBytes int64 `json:"sizeBytes"`
	DurationSec int `json:"durationSec"`
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
	Global Limits                 `json:"global"`
	Events []EventLimits          `json:"events"`
}

// EventLimits is a per-event override entry.
type EventLimits struct {
	EventID int64  `json:"eventId"`
	Limits  Limits `json:"limits"`
}
