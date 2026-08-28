package rtmp

// E2E: full production publish flow against a REAL node+app+SRS rig —
// authmod dance → publish (stream key with token) → optional real media
// forwarding (E2E_MEDIA=<file.flv>, paced at tag timestamps) → unpublish →
// the node's reportRecording emits recording:ready (app inserts a DB row).
// Skips without E2E_RTMP.

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestE2EProdRecordFlow(t *testing.T) {
	addr := os.Getenv("E2E_RTMP")
	if addr == "" {
		t.Skip("set E2E_RTMP (host:port of a real node RTMP gateway)")
	}
	user := os.Getenv("E2E_USER")
	pass := os.Getenv("E2E_PASS")
	key := os.Getenv("E2E_KEY")
	if user == "" || pass == "" || key == "" {
		user, pass, key = "admin@e2e.test", "e2e-pass-123", "e2euser?token=test"
	}

	c, cw, cr := danceAuth(t, addr, user, pass)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(key)})
	got := cmdField(cr)
	if !strings.Contains(got, "NetStream.Publish.Start") {
		t.Fatalf("publish: expected Publish.Start, got %q", got)
	}

	hold := 6 * time.Second
	if media := os.Getenv("E2E_MEDIA"); media != "" {
		// Real frames: lights up SRS's video width/height counters so the
		// node's 5s metrics monitor (first poll ~8s in) has something to
		// measure — the caller asserts avgFps/width/height on the row.
		forwardFLVMedia(t, cw, media)
		hold = 8 * time.Second // ≥ one monitor poll past the last frame
	}
	t.Logf("publishing as %q — holding %s for DVR+metrics", key, hold)
	time.Sleep(hold)
	c.Close()

	// caller asserts the app row from outside
	t.Log("disconnected — reportRecording should fire ~2s later")
}

// forwardFLVMedia replays a real FLV file's script/video/audio tags over the
// authenticated publish connection at the tags' own pace, exactly as a
// paced encoder would. FLV tag layout: 11-byte header (type, size 3B,
// timestamp 3B + ext 1B, streamID, ...) + payload + 4-byte prevTagSize.
func forwardFLVMedia(t *testing.T, cw *chunkWriter, path string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if len(b) < 13 || string(b[:3]) != "FLV" {
		t.Fatalf("%s: not an FLV file", path)
	}
	start := time.Now()
	i := 13 // 9-byte signature + 4-byte prevTagSize0

	for i+11 <= len(b) {
		typ := b[i]
		size := int(b[i+1])<<16 | int(b[i+2])<<8 | int(b[i+3])
		ts := uint32(b[i+7])<<24 | uint32(b[i+4])<<16 | uint32(b[i+5])<<8 | uint32(b[i+6])
		i += 11
		if i+size > len(b) {
			break
		}
		payload := b[i : i+size]
		i += size + 4 // skip payload + prevTagSize

		if typ != 8 && typ != 9 && typ != 18 {
			continue
		}
		// pace at the tags' own timestamps
		if d := time.Duration(ts)*time.Millisecond - time.Since(start); d > 0 {
			time.Sleep(d)
		}
		csid := uint32(4)
		if typ == 8 {
			csid = 6
		}
		if err := cw.WriteMessage(&Message{Type: typ, CSID: csid, StreamID: 1, Timestamp: ts, Payload: payload}); err != nil {
			t.Fatalf("forward tag type=%d ts=%d: %v", typ, ts, err)
		}
	}
	t.Logf("forwarded FLV media (%s): %d bytes replayed in %s", path, i, time.Since(start).Round(time.Millisecond))
}
