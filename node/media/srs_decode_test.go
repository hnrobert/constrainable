package media

// The SRS streams-API decoder: SRS ≥5 emits snake_case field names (captured
// live from ossrs/srs:6 on 2026-08-27), older builds camelCase — both must
// decode, and neither may silently zero the byte counters (a zero RecvBytes
// used to blank every measured bitrate).

import (
	"encoding/json"
	"testing"
)

// captured verbatim from ossrs/srs:6 /api/v1/streams while a real 640x360
// H264 stream was live (abridged to the fields we decode)
const srs6SnakeCase = `{
  "id": "vid-m084xs8",
  "name": "probe4@x.test",
  "vhost": "vid-8s933hj",
  "app": "test",
  "live_ms": 1787839365658,
  "clients": 1,
  "frames": 0,
  "send_bytes": 4387,
  "recv_bytes": 918404,
  "kbps": { "recv_30s": 373, "send_30s": 0 },
  "publish": { "active": true, "cid": "2a02u288" },
  "video": { "codec": "H264", "profile": "High", "level": "3", "width": 640, "height": 360 },
  "audio": null
}`

const srsLegacyCamelCase = `{
  "name": "user@x.test",
  "liveMs": 1787839365658,
  "frames": 250,
  "sendBytes": 4387,
  "recvBytes": 918404,
  "kbps": { "recv_30s": 373, "send_30s": 0 },
  "video": { "codec": "H264", "width": 1920, "height": 1080 }
}`

func TestSRSStreamInfoSnakeCase(t *testing.T) {
	var s SRSStreamInfo
	if err := json.Unmarshal([]byte(srs6SnakeCase), &s); err != nil {
		t.Fatal(err)
	}
	if s.RecvBytes != 918404 || s.SendBytes != 4387 || s.LiveMs != 1787839365658 {
		t.Fatalf("byte/time counters did not decode: %+v", s)
	}
	if s.Video == nil || s.Video.Width != 640 || s.Video.Height != 360 {
		t.Fatalf("video object did not decode: %+v", s.Video)
	}
	if s.Kbps.Recv30s != 373 {
		t.Fatalf("kbps did not decode: %+v", s.Kbps)
	}
	if s.TotalBitrateKbps() != 373 {
		t.Fatalf("total bitrate = %d, want 373", s.TotalBitrateKbps())
	}
}

func TestSRSStreamInfoCamelCaseFallback(t *testing.T) {
	var s SRSStreamInfo
	if err := json.Unmarshal([]byte(srsLegacyCamelCase), &s); err != nil {
		t.Fatal(err)
	}
	if s.RecvBytes != 918404 || s.LiveMs != 1787839365658 || s.Frames != 250 {
		t.Fatalf("legacy camelCase fields did not decode: %+v", s)
	}
}

// Declared-spec fallback: recordings of streams shorter than the first
// monitor poll (or on SRS builds whose frames counter stays 0) still carry
// the onMetaData geometry/framerate.
func TestSetDeclaredSpecFallback(t *testing.T) {
	m := NewManager(nil, func(int64, *Session) {}, func(int64, []string, *Session) {}, func(int64, int64, int, *Session) {})
	m.Start("u@x.com", 1, nil, "ev", "", nil, true)
	m.SetDeclaredSpec("u@x.com", 1280, 720, 29.97)

	s, ok := m.sessions["u@x.com"]
	if !ok {
		t.Fatal("session not tracked")
	}
	s.mu.Lock()
	w, h, fps := s.Width, s.Height, s.Fps
	s.mu.Unlock()
	if w != 1280 || h != 720 || fps != 29.97 {
		t.Fatalf("declared spec not stored: %dx%d@%v", w, h, fps)
	}
}
