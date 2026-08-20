package rtmp

import "testing"

// The strict declared-spec gate: metadata-time violations are checked LOCALLY
// against the grant's caps — nothing is relayed before the reject.
func TestSpecViolations(t *testing.T) {
	lim := &GateLimits{MaxWidth: 1920, MaxHeight: 1080, MaxFps: 30, MaxBitrateKbps: 4000}

	if r := SpecViolations(StreamSpec{Width: 1920, Height: 1080, Fps: 30, VideoKbps: 2500, AudioKbps: 128}, lim); len(r) != 0 {
		t.Fatalf("clean spec flagged: %v", r)
	}
	if r := SpecViolations(StreamSpec{Width: 2560, Height: 1440, Fps: 30, VideoKbps: 2500}, lim); len(r) != 1 || r[0] != "resolution exceeds limit" {
		t.Fatalf("resolution: %v", r)
	}
	if r := SpecViolations(StreamSpec{Width: 1280, Height: 720, Fps: 60, VideoKbps: 2500}, lim); len(r) != 1 || r[0] != "fps exceeds limit" {
		t.Fatalf("fps: %v", r)
	}
	// declared video+audio vs the cap
	if r := SpecViolations(StreamSpec{Width: 1280, Height: 720, Fps: 30, VideoKbps: 3900, AudioKbps: 200}, lim); len(r) != 1 || r[0] != "bitrate exceeds limit" {
		t.Fatalf("bitrate: %v", r)
	}
	// multiple at once
	if r := SpecViolations(StreamSpec{Width: 4096, Height: 2160, Fps: 60, VideoKbps: 8000}, lim); len(r) != 3 {
		t.Fatalf("multi: %v", r)
	}
	// zero caps = uncapged
	if r := SpecViolations(StreamSpec{Width: 99999, Height: 1, Fps: 900, VideoKbps: 1e6}, &GateLimits{}); len(r) != 0 {
		t.Fatalf("zero limits must not flag: %v", r)
	}
}
