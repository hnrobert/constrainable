package media

import (
	"testing"

	"media-node/node"
)

// Bitrate limits mean the OBS "Video Bitrate" field. The measured check gets
// a VIDEO estimate (total received minus declared audio) with 10% headroom
// for RTMP overhead + encoder ABR overshoot — a stream set exactly at the
// cap must not flag, one clearly over must.
func TestCheckLimitsBitrateVideoSemantics(t *testing.T) {
	lim := &node.Limits{MaxVideoBitrateKbps: 1000}

	// exactly at cap (even with overhead riding on the estimate) → clean
	if r := checkLimits(&Session{Width: 1280, Height: 720, Fps: 30, BitrateKbps: 1000}, lim); len(r) != 0 {
		t.Fatalf("at-cap stream flagged: %v", r)
	}
	// inside the 10% headroom (overhead/ABR) → clean
	if r := checkLimits(&Session{Width: 1280, Height: 720, Fps: 30, BitrateKbps: 1090}, lim); len(r) != 0 {
		t.Fatalf("within-headroom stream flagged: %v", r)
	}
	// clearly over → flagged
	if r := checkLimits(&Session{Width: 1280, Height: 720, Fps: 30, BitrateKbps: 1200}, lim); len(r) != 1 || r[0] != "bitrate exceeds limit" {
		t.Fatalf("over-cap stream: %v", r)
	}
}

// SetDeclaredAudioKbps clamps: a forged huge audiodatarate must not zero the
// video estimate (measured mode is the anti-forgery layer).
func TestSetDeclaredAudioClamped(t *testing.T) {
	m := &Manager{sessions: map[string]*Session{}}
	m.sessions["s"] = &Session{active: true}

	m.SetDeclaredAudioKbps("s", 100000)
	if got := m.sessions["s"].declaredAudioKbps; got != 320 {
		t.Fatalf("forged audio declaration clamped to 320, got %d", got)
	}
	m.SetDeclaredAudioKbps("s", -5)
	if got := m.sessions["s"].declaredAudioKbps; got != 0 {
		t.Fatalf("negative audio declaration clamped to 0, got %d", got)
	}
	m.SetDeclaredAudioKbps("s", 160)
	if got := m.sessions["s"].declaredAudioKbps; got != 160 {
		t.Fatalf("sane audio declaration kept, got %d", got)
	}

	// unknown stream → no-op, no panic
	m.SetDeclaredAudioKbps("missing", 128)
}
