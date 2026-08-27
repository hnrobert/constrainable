package main

// Verifies reportRecording's reporting contract under the app=eventKey layout
// (since v0.7.0): SRS DVR writes segments DIRECTLY to RECORD_DIR/<eventKey>/
// <stream>/ (dvr_path /records/[app]/[stream]/), reportRecording only scans
// and reports — it must NOT move, rename, or create anything.

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

func writeSegment(t *testing.T, root, dir, name string, size int) {
	t.Helper()
	full := filepath.Join(root, dir)
	if err := os.MkdirAll(full, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(full, name), make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

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

func TestReportRecordingEventKeyLayout(t *testing.T) {
	root := t.TempDir()
	stream := "u@x.com"
	writeSegment(t, root, filepath.Join("myevent", stream), "2026-08-26_10-00-00.000.flv", 100)
	cfg := &Config{RecordDir: root}
	fc := &fakeClient{emitted: map[string]int{}}

	s := &media.Session{
		StreamName: stream,
		EventKey:   "myevent",
		StartedAt:  time.Now().Add(-60 * time.Second),
	}
	reportRecording(cfg, fc, s)
	waitFor(t, fc, 1)

	if fc.emitted["recording:ready"] != 1 {
		t.Fatalf("recording:ready not emitted: %v", fc.emitted)
	}
	rep, ok := fc.last.(node.RecordingReady)
	if !ok || len(rep.Segments) != 1 {
		t.Fatalf("bad report payload: %+v", rep)
	}
	want := "myevent/u@x.com/2026-08-26_10-00-00.000.flv"
	if rep.Segments[0].RelPath != want {
		t.Fatalf("rel path = %q, want %q", rep.Segments[0].RelPath, want)
	}
	// the file must be UNTOUCHED — no move, no rewrite
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(want))); err != nil {
		t.Fatalf("segment moved or missing at final layout: %v", err)
	}
}

// Event-less (or event-row-deleted mid-session) publishes land under the
// plain "live" app — the report must derive the SAME directory the relay
// published under (there is no e<eventId> step on the publish side).
func TestReportRecordingLiveFallbackWithEventId(t *testing.T) {
	root := t.TempDir()
	writeSegment(t, root, filepath.Join("live", "u@x.com"), "a.flv", 10)
	cfg := &Config{RecordDir: root}
	fc := &fakeClient{emitted: map[string]int{}}

	evID := int64(7)
	s := &media.Session{
		StreamName: "u@x.com",
		EventID:    &evID, // event id known but no key → "live" bucket
		StartedAt:  time.Now().Add(-10 * time.Second),
	}
	reportRecording(cfg, fc, s)
	waitFor(t, fc, 1)

	if fc.emitted["recording:ready"] != 1 {
		t.Fatalf("recording:ready not emitted: %v", fc.emitted)
	}
	rep := fc.last.(node.RecordingReady)
	if len(rep.Segments) != 1 || rep.Segments[0].RelPath != "live/u@x.com/a.flv" {
		t.Fatalf("bad report payload: %+v", rep)
	}
}

func TestReportRecordingLiveFallback(t *testing.T) {
	root := t.TempDir()
	writeSegment(t, root, filepath.Join("live", "ip-1.2.3.4"), "b.flv", 10)
	cfg := &Config{RecordDir: root}
	fc := &fakeClient{emitted: map[string]int{}}

	s := &media.Session{
		StreamName: "ip-1.2.3.4", // anonymous, no event
		StartedAt:  time.Now().Add(-10 * time.Second),
	}
	reportRecording(cfg, fc, s)
	waitFor(t, fc, 1)

	rep := fc.last.(node.RecordingReady)
	if len(rep.Segments) != 1 || rep.Segments[0].RelPath != "live/ip-1.2.3.4/b.flv" {
		t.Fatalf("bad report payload: %+v", rep)
	}
}

// Boot-time sweep: only watch-twin junk (live/clean-*) is removed — real
// anonymous recordings under live/<stream> stay.
func TestSweepCleanTwinJunk(t *testing.T) {
	root := t.TempDir()
	writeSegment(t, root, filepath.Join("live", "clean-junk@x.com"), "a.flv", 10)
	writeSegment(t, root, filepath.Join("live", "ip-1.2.3.4"), "b.flv", 10)
	writeSegment(t, root, filepath.Join("myevent", "u@x.com"), "c.flv", 10)

	sweepCleanTwinJunk(root)

	if _, err := os.Stat(filepath.Join(root, "live", "clean-junk@x.com")); !os.IsNotExist(err) {
		t.Fatal("clean- junk dir survived the sweep")
	}
	for _, keep := range []string{
		filepath.Join(root, "live", "ip-1.2.3.4", "b.flv"),
		filepath.Join(root, "myevent", "u@x.com", "c.flv"),
	} {
		if _, err := os.Stat(keep); err != nil {
			t.Fatalf("real recording must survive the sweep: %v", err)
		}
	}
}

// The final layout doubles as the archive: the stream directory holds every
// session's segments. A republish must report ONLY this session's files —
// yesterday's segments (mtime before the session started) are already in an
// earlier report, and re-reporting them would duplicate rows' segment lists
// and resurrect files whose recording was deleted in between.
func TestReportRecordingSessionWindowOnly(t *testing.T) {
	root := t.TempDir()
	stream := "u@x.com"
	dir := filepath.Join("myevent", stream)
	writeSegment(t, root, dir, "2026-08-25_old.flv", 50) // previous session
	writeSegment(t, root, dir, "2026-08-26_new.flv", 70) // this session
	old := filepath.Join(root, dir, "2026-08-25_old.flv")
	past := time.Now().Add(-24 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{RecordDir: root}
	fc := &fakeClient{emitted: map[string]int{}}

	s := &media.Session{
		StreamName: stream,
		EventKey:   "myevent",
		StartedAt:  time.Now().Add(-60 * time.Second),
	}
	reportRecording(cfg, fc, s)
	waitFor(t, fc, 1)

	if fc.emitted["recording:ready"] != 1 {
		t.Fatalf("recording:ready not emitted: %v", fc.emitted)
	}
	rep := fc.last.(node.RecordingReady)
	if len(rep.Segments) != 1 || rep.Segments[0].RelPath != "myevent/u@x.com/2026-08-26_new.flv" {
		t.Fatalf("expected only the session-window segment, got: %+v", rep.Segments)
	}
	if rep.SizeBytes != 70 {
		t.Fatalf("size = %d, want 70 (old segment must not be counted)", rep.SizeBytes)
	}
}
