package node

import (
	"os"
	"testing"
	"time"
)

// TestWsClientHandshake is a LIVE integration test against a running app:
// it skips unless WS_SMOKE_APP is set (e.g. WS_SMOKE_APP=http://127.0.0.1:32954
// WS_SMOKE_WS=ws://127.0.0.1:31955 go test ./node -run TestWsClientHandshake -v).
// Validates the full handshake: hello → hello_ack (nodeId) → limits_config
// event, plus an emit.
func TestWsClientHandshake(t *testing.T) {
	appURL := os.Getenv("WS_SMOKE_APP")
	if appURL == "" {
		t.Skip("set WS_SMOKE_APP to run the live handshake test")
	}
	wsURL := os.Getenv("WS_SMOKE_WS")
	if wsURL == "" {
		wsURL = "ws://127.0.0.1:31955"
	}

	cfgCh := make(chan struct{}, 1)
	c := NewWsClient(appURL, wsURL, "", RegisterPayload{
		Identifier: "go-smoke",
		Hostname:   "go-smoke-host",
		Version:    "test",
	})
	c.SetOnConfig(func(ConfigLimits) { cfgCh <- struct{}{} })
	go c.Run()
	defer c.Close()

	// The client retries internally (3s loop); allow for slow app boot.
	deadline := time.Now().Add(15 * time.Second)
	for (c.NodeID() == "" || !c.IsConnected()) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if c.NodeID() == "" {
		t.Fatal("no hello_ack (nodeId) within 15s")
	}
	if !c.IsConnected() {
		t.Fatal("not connected after hello_ack")
	}
	t.Logf("registered as nodeId=%s", c.NodeID())

	select {
	case <-cfgCh:
		t.Log("limits_config received")
	case <-time.After(5 * time.Second):
		t.Fatal("no limits_config event within 5s")
	}

	// Unknown session → the app no-ops, but the emit path must succeed.
	if err := c.Emit("publish:metrics", MetricsReport{SessionID: 999999, Width: 1280, Height: 720, Fps: 30}); err != nil {
		t.Fatalf("emit publish:metrics: %v", err)
	}
}
