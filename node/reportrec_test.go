package main

// Verifies reportRecording's on-disk layout contract: SRS DVR drops FLV
// segments under RECORD_DIR/<stream>/; reportRecording must MOVE them to
// <eventKey>/<stream>/ (fallback e<id>/) and emit recording:ready with the
// post-move rel paths.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"media-node/media"
	"media-node/node"
)

type fakeClient struct {
	emitted map[string]int
	last    any
}

func (f *fakeClient) Run()              {}
func (f *fakeClient) Close()            {}
func (f *fakeClient) NodeID() string    { return "test-node" }
func (f *fakeClient) IsConnected() bool { return true }
func (f *fakeClient) Emit(event string, payload any) error {
	f.emitted[event]++
	f.last = payload
	return nil
}
func (f *fakeClient) EmitWithAck(string, any, any, time.Duration) error { return nil }
func (f *fakeClient) Salt(string) node.SaltResult                       { return node.SaltResult{} }
func (f *fakeClient) Verify(string, string, string, string) node.VerifyResult {
	return node.VerifyResult{}
}
func (f *fakeClient) Policy(string, string) node.PolicyResult { return node.PolicyResult{} }
func (f *fakeClient) VerifySpec(node.PublishSpec) (node.SpecVerdict, error) {
	return node.SpecVerdict{}, nil
}
func (f *fakeClient) SetOnKick(func(node.NodeKick))                {}
func (f *fakeClient) SetOnConfig(func(node.ConfigLimits))          {}
func (f *fakeClient) SetOnDelete(func(node.RecordingDelete) error) {}

// reportRecording runs in its own goroutine after a 2s delay — wait for
// its emit (or fail after 10s).
func waitFor(t *testing.T, fc *fakeClient, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fc.emitted["recording:ready"] >= want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func writeSegment(t *testing.T, root, stream, name string, size int) {
	t.Helper()
	dir := filepath.Join(root, stream)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReportRecordingEventKeyLayout(t *testing.T) {
	root := t.TempDir()
	writeSegment(t, root, "u@x.com", "2026-08-26_10-00-00.000.flv", 100)
	cfg := &Config{RecordDir: root}
	fc := &fakeClient{emitted: map[string]int{}}

	s := &media.Session{
		StreamName: "u@x.com",
		EventKey:   "myevent",
		StartedAt:  time.Now().Add(-60 * time.Second),
	}
	reportRecording(cfg, fc, s)
	waitFor(t, fc, 1)

	moved := filepath.Join(root, "myevent", "u@x.com", "2026-08-26_10-00-00.000.flv")
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("segment was NOT moved to <eventKey>/<stream>/: %v", err)
	}
	if fc.emitted["recording:ready"] != 1 {
		t.Fatalf("recording:ready not emitted: %v", fc.emitted)
	}
	rep, ok := fc.last.(node.RecordingReady)
	if !ok || len(rep.Segments) != 1 || rep.Segments[0].RelPath != "myevent/u@x.com/2026-08-26_10-00-00.000.flv" {
		t.Fatalf("bad report payload: %+v", rep)
	}
}

func TestReportRecordingEventIdFallback(t *testing.T) {
	root := t.TempDir()
	writeSegment(t, root, "u@x.com", "a.flv", 10)
	cfg := &Config{RecordDir: root}
	fc := &fakeClient{emitted: map[string]int{}}

	evID := int64(7)
	s := &media.Session{
		StreamName: "u@x.com",
		EventID:    &evID,
		StartedAt:  time.Now().Add(-10 * time.Second),
	}
	reportRecording(cfg, fc, s)
	waitFor(t, fc, 1)

	if _, err := os.Stat(filepath.Join(root, "e7", "u@x.com", "a.flv")); err != nil {
		t.Fatalf("segment was NOT moved to e<id>/<stream>/: %v", err)
	}
	if fc.emitted["recording:ready"] != 1 {
		t.Fatalf("recording:ready not emitted: %v", fc.emitted)
	}
}
