package main

import "testing"

func TestSRSRTCCandidateDerivation(t *testing.T) {
	cases := []struct {
		name             string
		rtcEnv, originEnv string
		want             string
	}{
		{"explicit env wins", "10.1.2.3", "https://ingest.example.com", "10.1.2.3"},
		{"derived from origin host", "", "https://ingest.example.com:8443/base", "ingest.example.com"},
		{"bare origin host", "", "ingest.example.com", "ingest.example.com"},
		{"single-server default", "", "", "127.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SRS_RTC_CANDIDATE", tc.rtcEnv)
			t.Setenv("PUBLIC_NODE_ORIGIN", tc.originEnv)
			t.Setenv("NODE_IDENTIFIER", "test-node")
			c, err := LoadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if c.SRSRTCCandidate != tc.want {
				t.Fatalf("candidate = %q, want %q", c.SRSRTCCandidate, tc.want)
			}
		})
	}
}
