package node

import (
	"bufio"
	"net"
	"testing"
	"time"
)

// A server that accepts TCP (and completes NO websocket exchange) must not
// wedge the client: the handshake read is deadline-bounded, connectOnce
// errors, and Run() retries. Regression for the silent-half-open case where
// the old client blocked on Receive forever and never reconnected.
func TestHandshakeDeadlineOnSilentServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			// accept and stay SILENT forever (never even the HTTP 101)
			go func(c net.Conn) {
				bufio.NewReader(c) // hold it open
				<-time.After(60 * time.Second)
				_ = c.Close()
			}(conn)
		}
	}()

	c := NewClient("http://"+ln.Addr().String(), "", RegisterPayload{Origin: "t", Hostname: "h", Version: "t"})
	start := time.Now()
	err = c.connectOnce()
	elapsed := time.Since(start)
	if err == nil {
		t.Fatalf("expected handshake error on silent server, got nil")
	}
	if elapsed > 15*time.Second {
		t.Fatalf("handshake took %v — deadline not applied (would hang forever pre-fix)", elapsed)
	}
	t.Logf("silent server detected in %v: %v", elapsed.Round(time.Millisecond), err)
}

// markDead must clear both flags so Emit fails fast ("not connected")
// instead of writing to a dead socket.
func TestMarkDeadClearsState(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "", RegisterPayload{Origin: "t"})
	// simulate a live connection: markDead(nil) with c.ws==nil clears flags only
	c.mu.Lock()
	c.connected = true
	c.mu.Unlock()
	if !c.IsConnected() {
		t.Fatal("precondition failed")
	}
	c.markDead(nil)
	if c.IsConnected() {
		t.Fatal("markDead should clear connected")
	}
	if err := c.Emit("x", map[string]string{}); err == nil {
		t.Fatal("Emit on dead client should fail fast")
	}
}
