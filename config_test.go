package main

import "testing"

func TestSRSRTCCandidateDerivation(t *testing.T) {
	cases := []struct {
		name                string
		rtcEnv, rtmpAuthEnv string
		want                string
	}{
		{"explicit env wins", "10.1.2.3", "ingest.example.com", "10.1.2.3"},
		{"derived from rtmp authority host", "", "ingest.example.com:21935", "ingest.example.com"},
		{"no public config → loopback", "", "", "127.0.0.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SRS_RTC_CANDIDATE", tc.rtcEnv)
			t.Setenv("PUBLIC_RTMP_AUTHORITY", tc.rtmpAuthEnv)
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
