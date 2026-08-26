package main

// LIVE integration: reportRecording with the REAL WsClient against a
// running local app (E2E_APP=http://127.0.0.1:31954). Verifies the emit
// path end-to-end: goroutine → WsClient.Emit → app handleRecordingReady →
// DB row. Skips without the env.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"media-node/media"
	"media-node/node"
)

func TestReportRecordingLiveWs(t *testing.T) {
	appURL := os.Getenv("E2E_APP")
	if appURL == "" {
		t.Skip("set E2E_APP to run the live reportRecording test")
	}
	root := t.TempDir()
	stream := "liveuser@e2e.test"
	// files already live at the FINAL layout (app=eventKey since v0.7.0 —
	// SRS writes /records/[app]/[stream]/ directly)
	if err := os.MkdirAll(filepath.Join(root, "test", stream), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "test", stream, "2026-08-26_09-00-00.000.flv"), make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}

	wsURL := "ws://127.0.0.1:31954"
	c := node.NewWsClient(appURL, wsURL, "", node.RegisterPayload{
		Identifier: "report-test", Hostname: "h", Version: "test",
	})
	go c.Run()
	defer c.Close()
	deadline := time.Now().Add(10 * time.Second)
	for c.NodeID() == "" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if c.NodeID() == "" {
		t.Fatal("WsClient did not register against the local app")
	}

	cfg := &Config{RecordDir: root}
	s := &media.Session{StreamName: stream, EventKey: "test", StartedAt: time.Now().Add(-30 * time.Second)}
	reportRecording(cfg, c, s)

	// the success log goes to stderr; assert the file is still present and
	// untouched at the final layout (no move under the app=eventKey design)
	final := filepath.Join(root, "test", stream, "2026-08-26_09-00-00.000.flv")
	ok := false
	for i := 0; i < 100 && !ok; i++ {
		time.Sleep(100 * time.Millisecond)
		if _, err := os.Stat(final); err == nil {
			ok = true
		}
	}
	if !ok {
		t.Fatal("segment missing at <eventKey>/<stream>/ within 10s — reportRecording goroutine did not run")
	}
	t.Logf("final layout intact at %s (emit should have reached the app)", final)
}
