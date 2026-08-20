package main

import "testing"

// The PUBLIC_* env vars are ADVERTISED IDENTITY ONLY — they must never move
// a listener bind or the SRS config render. Setting every PUBLIC_* to values
// that differ from the internal ones leaves the internal ports untouched.
func TestPublicVarsNeverTouchListeners(t *testing.T) {
	t.Setenv("NODE_IDENTIFIER", "n")
	t.Setenv("PUBLIC_MEDIA_NODE_ORIGIN", "ingest.example.com")
	t.Setenv("PUBLIC_MEDIA_NODE_RTMP_PORT", "21935")
	t.Setenv("PUBLIC_MEDIA_NODE_PROBE_UDP_PORT", "48111")
	t.Setenv("PUBLIC_MEDIA_NODE_SRS_UDP_PORT", "48000")
	// internal overrides in the SAME process — must win over nothing above
	t.Setenv("RTMP_PORT", "19350")
	t.Setenv("PROBE_UDP_PORT", "38111")
	t.Setenv("SRS_UDP_PORT", "38000")

	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.RTMPPort != 19350 {
		t.Fatalf("RTMP listener moved by a PUBLIC_* var: %d", c.RTMPPort)
	}
	if c.ProbeUDPPort != 38111 {
		t.Fatalf("probe listener moved by a PUBLIC_* var: %d", c.ProbeUDPPort)
	}
	if c.SRSUDPPort != 38000 {
		t.Fatalf("SRS rtc render moved by a PUBLIC_* var: %d", c.SRSUDPPort)
	}
	// advertised identity carries the PUBLIC values
	if c.PublicRTMPPort != 21935 || c.PublicProbeUDPPort != 48111 || c.PublicSrsUDPPort != 48000 {
		t.Fatalf("advertised ports wrong: %d/%d/%d", c.PublicRTMPPort, c.PublicProbeUDPPort, c.PublicSrsUDPPort)
	}
}

// With nothing PUBLIC_* set, advertised defaults mirror the internal ports
// (identity matches the deployment out of the box).
func TestPublicDefaultsMirrorInternal(t *testing.T) {
	t.Setenv("NODE_IDENTIFIER", "n")
	t.Setenv("RTMP_PORT", "1936")
	t.Setenv("PROBE_UDP_PORT", "38112")
	t.Setenv("SRS_UDP_PORT", "38001")

	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicRTMPPort != 1936 || c.PublicProbeUDPPort != 38112 || c.PublicSrsUDPPort != 38001 {
		t.Fatalf("defaults must mirror internal when PUBLIC_* unset: %d/%d/%d", c.PublicRTMPPort, c.PublicProbeUDPPort, c.PublicSrsUDPPort)
	}
}
