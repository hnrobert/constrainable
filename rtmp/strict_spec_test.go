package rtmp

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The strict declared-spec gate: metadata-time violations are checked LOCALLY
// against the grant's caps — nothing is relayed before the reject.
func TestSpecViolations(t *testing.T) {
	lim := &GateLimits{MaxWidth: 1920, MaxHeight: 1080, MaxFps: 30, MaxVideoBitrateKbps: 4000}

	if r := SpecViolations(StreamSpec{Width: 1920, Height: 1080, Fps: 30, VideoKbps: 2500, AudioBitrateKbps: 128}, lim); len(r) != 0 {
		t.Fatalf("clean spec flagged: %v", r)
	}
	if r := SpecViolations(StreamSpec{Width: 2560, Height: 1440, Fps: 30, VideoKbps: 2500}, lim); len(r) != 1 || r[0] != "resolution exceeds limit" {
		t.Fatalf("resolution: %v", r)
	}
	if r := SpecViolations(StreamSpec{Width: 1280, Height: 720, Fps: 60, VideoKbps: 2500}, lim); len(r) != 1 || r[0] != "fps exceeds limit" {
		t.Fatalf("fps: %v", r)
	}
	// bitrate = the VIDEO rate only (OBS' "Video Bitrate" field semantics) —
	// the audio track must not count toward the cap
	if r := SpecViolations(StreamSpec{Width: 1280, Height: 720, Fps: 30, VideoKbps: 3900, AudioBitrateKbps: 200}, lim); len(r) != 0 {
		t.Fatalf("audio must not count toward the bitrate cap: %v", r)
	}
	if r := SpecViolations(StreamSpec{Width: 1280, Height: 720, Fps: 30, VideoKbps: 4100}, lim); len(r) != 1 || r[0] != "bitrate exceeds limit" {
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

// End-to-end spec rejection: publish accepted → violating onMetaData (type-18
// DATA message, as OBS sends it) → BadName with the reason + the connection
// CLOSED by the server. This is the OBS-terminal "wrong password" UX — without
// the close, OBS just keeps streaming.
func TestSpecRejectClosesConnection(t *testing.T) {
	const token = "test-token"
	const openKey = "openkey123"
	app := httptest.NewServer(mockAppMux(token, "", openKey, "", "", ""))
	defer app.Close()
	addr := startGateway(t, app.URL, token)

	names := make(chan string, 8)
	oldSRS := SRSAddr
	SRSAddr = fakeSRS(t, names)
	defer func() { SRSAddr = oldSRS }()

	oldGate, oldSpec := OnPublishGate, OnPublishSpec
	OnPublishGate = func(streamName, tok, authedUser string) PublishGrant {
		return PublishGrant{
			Allowed: true,
			Limits:  &GateLimits{MaxWidth: 1280, MaxHeight: 720, MaxFps: 30, MaxVideoBitrateKbps: 2000},
			Strict:  true,
		}
	}
	specSeen := make(chan StreamSpec, 1)
	OnPublishSpec = func(streamName string, spec StreamSpec, limits *GateLimits, strict bool) (bool, string) {
		specSeen <- spec
		return false, "Stream rejected: resolution exceeds limit. Lower your OBS resolution and reconnect."
	}
	defer func() {
		OnPublishGate, OnPublishSpec = oldGate, oldSpec
		specCooldownMu.Lock()
		specCooldowns = map[string]time.Time{}
		specCooldownMu.Unlock()
	}()

	c, cw, cr := credlessConnect(t, addr)
	defer c.Close()
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(openKey)})
	if got := cmdField(cr); !strings.Contains(got, "NetStream.Publish.Start") {
		t.Fatalf("publish: expected Publish.Start, got %q", got)
	}

	// OBS declares 1920x1080 — over the 1280x720 grant caps
	_ = cw.WriteMessage(&Message{Type: 18, CSID: 4, StreamID: 1, Payload: encodeAMF0Metadata(t)})
	if got := cmdField(cr); !strings.Contains(got, "resolution exceeds limit") {
		t.Fatalf("metadata: expected spec-reject BadName, got %q", got)
	}

	// the server must close the connection — a lingering open conn means OBS
	// keeps streaming (the bug this test guards against)
	readErr := make(chan error, 1)
	go func() {
		_, err := cr.ReadMessage()
		readErr <- err
	}()
	select {
	case err := <-readErr:
		if err == nil {
			t.Fatal("expected the connection to close after the spec reject, got another message")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("connection still open 3s after the spec reject — OBS would keep streaming")
	}

	select {
	case sp := <-specSeen:
		if sp.Width != 1920 || sp.Height != 1080 {
			t.Fatalf("spec hook: expected 1920x1080, got %dx%d", sp.Width, sp.Height)
		}
	default:
		t.Fatal("spec hook never fired")
	}
}

// The reject above closes a connection OBS already considers LIVE, so OBS's
// auto-reconnect kicks in. The cooldown must turn those reconnects into a
// FATAL connect error (librtmp reason=authfailed — same as a wrong password)
// so OBS stops instead of loop-publishing.
func TestSpecRejectCooldownKillsReconnect(t *testing.T) {
	const (
		token    = "test-token"
		authKey  = "authkey123"
		user     = "robert@example.com"
		password = "123456"
		salt     = "deadbeefsalt"
	)
	salted2 := b64(md5raw(user + salt + password))
	app := httptest.NewServer(mockAppMux(token, authKey, "", user, salt, salted2))
	defer app.Close()
	addr := startGateway(t, app.URL, token)

	names := make(chan string, 8)
	oldSRS := SRSAddr
	SRSAddr = fakeSRS(t, names)
	defer func() { SRSAddr = oldSRS }()

	oldGate, oldSpec := OnPublishGate, OnPublishSpec
	OnPublishGate = func(streamName, tok, authedUser string) PublishGrant {
		return PublishGrant{Allowed: true, Strict: true,
			Limits: &GateLimits{MaxWidth: 1280, MaxHeight: 720}}
	}
	OnPublishSpec = func(streamName string, spec StreamSpec, limits *GateLimits, strict bool) (bool, string) {
		return false, "Stream rejected: resolution exceeds limit. Lower your OBS resolution and reconnect."
	}
	defer func() {
		OnPublishGate, OnPublishSpec = oldGate, oldSpec
		specCooldownMu.Lock()
		specCooldowns = map[string]time.Time{}
		specCooldownMu.Unlock()
	}()

	// cycle 1: full publish → violating metadata → BadName + close
	c, cw, cr := danceAuth(t, addr, user, password)
	_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, StreamID: 1, Payload: CmdPublish(authKey)})
	if got := cmdField(cr); !strings.Contains(got, "NetStream.Publish.Start") {
		t.Fatalf("publish: expected Publish.Start, got %q", got)
	}
	_ = cw.WriteMessage(&Message{Type: 18, CSID: 4, StreamID: 1, Payload: encodeAMF0Metadata(t)})
	if got := cmdField(cr); !strings.Contains(got, "resolution exceeds limit") {
		t.Fatalf("metadata: expected spec-reject BadName, got %q", got)
	}
	c.Close()

	// the auto-reconnect: stage-2 of the dance must be refused FATAALLY —
	// reason=authfailed (a wrong password's terminal form), never needauth
	c2, cw2, cr2 := openClient(t, addr)
	defer c2.Close()
	sendConnect(cw2, "live?authmod=adobe&user="+user)
	if got := cmdField(cr2); !strings.Contains(got, "reason=authfailed") {
		t.Fatalf("reconnect stage2: expected fatal authfailed (cooldown), got %q", got)
	}
}
