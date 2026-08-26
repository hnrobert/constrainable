package rtmp

// E2E: full production publish flow against a REAL node+app+SRS rig —
// authmod dance → publish (stream key with token) → unpublish → the node's
// reportRecording must move the DVR file to <eventKey>/<stream>/ and emit
// recording:ready (app inserts a DB row). Skips without E2E_RTMP.

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
	t.Logf("publishing as %q — holding 6s for DVR", key)
	time.Sleep(6 * time.Second)
	c.Close()

	// caller asserts the file move + app row from outside
	t.Log("disconnected — reportRecording should fire ~2s later")
}
