package node

// env-gated throwaway repro: dials a WS endpoint with x/net/websocket (the
// exact client the media node uses) and echoes one binary frame.
// REPRO_WS=ws://127.0.0.1:33001/ go test ./node -run TestReproHandshake -v

import (
	"os"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestReproHandshake(t *testing.T) {
	target := os.Getenv("REPRO_WS")
	if target == "" {
		t.Skip("set REPRO_WS")
	}
	_ = os.Setenv("REPRO_WS", target)
	ws, err := websocket.Dial(target, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.Close()
	_ = ws.SetDeadline(time.Now().Add(5 * time.Second))
	payload := []byte("hello-repro")
	if err := websocket.Message.Send(ws, payload); err != nil {
		t.Fatalf("send: %v", err)
	}
	var buf []byte
	if err := websocket.Message.Receive(ws, &buf); err != nil {
		t.Fatalf("receive: %v", err)
	}
	t.Logf("echoed %d bytes: %q", len(buf), buf)
}
