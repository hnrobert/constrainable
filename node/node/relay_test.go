package node

// Regression for the 2026-08-25 playback outage: the WHEP relay must send
// the stream name with a LITERAL '@' — SRS does not URL-decode the WHEP
// query, so '%40' resolves the subscriber to a different (empty) RTC source
// than the RTMP publisher feeds.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWhepRelayKeepsLiteralAt(t *testing.T) {
	var gotPath string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.RequestURI()
		w.WriteHeader(201)
		_, _ = w.Write([]byte("answer-sdp"))
	}))
	defer ts.Close()

	answer, errStr := whepRelayHTTP(ts.URL, "user@example.com", []byte("offer"))
	if errStr != "" || answer != "answer-sdp" {
		t.Fatalf("relay failed: answer=%q err=%q", answer, errStr)
	}
	if !strings.Contains(gotPath, "stream=user@example.com") {
		t.Fatalf("stream name was escaped in the query: %s", gotPath)
	}
	if strings.Contains(gotPath, "%40") {
		t.Fatalf("@ must stay literal: %s", gotPath)
	}
}
