// Hand-rolled minimal Engine.IO v4 + Socket.IO v5 client over WebSocket.
// The wire protocol is tiny: engine.io open/ping-pong, socket.io connect/event/ack.
// This avoids dragging in a third-party dependency with a different EIO version.
package node

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

// Client manages the persistent Socket.IO connection to the Node control plane.
type Client struct {
	nodeOrigin string // e.g. http://node:31954
	token      string
	register   RegisterPayload

	mu       sync.Mutex
	ws       *websocket.Conn
	nodeID   string
	connected bool

	// pending acks: requestID → channel
	pending sync.Map

	// event handlers (set by the owner before Connect)
	OnKick     func(NodeKick)
	OnDelete   func(RecordingDelete) error
	OnConfig   func(ConfigLimits)

	reconnectCh chan struct{}
	done        chan struct{}
}

// NewClient creates a Socket.IO client for the Node control plane.
func NewClient(nodeOrigin, token string, reg RegisterPayload) *Client {
	return &Client{
		nodeOrigin:  strings.TrimRight(nodeOrigin, "/"),
		token:       token,
		register:    reg,
		reconnectCh: make(chan struct{}, 1),
		done:        make(chan struct{}),
	}
}

// NodeID returns the assigned node ID (empty until registered).
func (c *Client) NodeID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nodeID
}

// IsConnected reports whether the socket is currently live.
func (c *Client) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// Run starts the connection loop: connect → register → serve events →
// reconnect on drop. Blocks until done is closed.
func (c *Client) Run() {
	for {
		select {
		case <-c.done:
			return
		default:
		}
		if err := c.connectOnce(); err != nil {
			log.Printf("[node] connection error: %v (retrying in 3s)", err)
			select {
			case <-time.After(3 * time.Second):
			case <-c.done:
				return
			}
		}
	}
}

// Close shuts down the connection loop.
func (c *Client) Close() {
	close(c.done)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ws != nil {
		_ = c.ws.Close()
	}
}

// connectOnce establishes a WebSocket, performs the engine.io + socket.io
// handshake, registers, and reads events until the connection drops.
func (c *Client) connectOnce() error {
	// Build the engine.io polling handshake URL (we need the session ID).
	// For simplicity, we use the websocket transport directly.
	wsURL, err := c.wsURL()
	if err != nil {
		return fmt.Errorf("build ws url: %w", err)
	}

	ws, err := websocket.Dial(wsURL, "", c.nodeOrigin)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}

	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()

	// Send engine.io OPEN is implicit with websocket transport (server sends "0{sid}")
	// Read the engine.io open packet
	var msg string
	if err := websocket.Message.Receive(ws, &msg); err != nil {
		return fmt.Errorf("read engine.io open: %w", err)
	}
	if !strings.HasPrefix(msg, "0") {
		return fmt.Errorf("expected engine.io open, got %q", msg[:min(len(msg), 20)])
	}

	// Send socket.io CONNECT to the /media-node namespace
	// Format: 40/media-node,{"token":"..."} (empty token → no auth)
	authPayload := fmt.Sprintf(`{"token":%q}`, c.token)
	connectPayload := "40/media-node," + authPayload
	if err := websocket.Message.Send(ws, connectPayload); err != nil {
		return fmt.Errorf("send socket.io connect: %w", err)
	}

	// Read the socket.io CONNECT ack: 40/media-node,
	if err := websocket.Message.Receive(ws, &msg); err != nil {
		return fmt.Errorf("read socket.io connect ack: %w", err)
	}
	if !strings.HasPrefix(msg, "40/media-node") {
		return fmt.Errorf("expected socket.io connect ack, got %q", msg[:min(len(msg), 40)])
	}

	c.mu.Lock()
	c.connected = true
	c.mu.Unlock()
	log.Printf("[node] connected to %s/media-node", c.nodeOrigin)

	// Register
	regData, _ := json.Marshal(c.register)
	regMsg := fmt.Sprintf(`42["node:register",%s]`, regData)
	if err := websocket.Message.Send(ws, regMsg); err != nil {
		return fmt.Errorf("send register: %w", err)
	}

	// Read events until disconnect
	err = c.readLoop(ws)

	c.mu.Lock()
	c.connected = false
	c.mu.Unlock()
	log.Printf("[node] disconnected: %v", err)
	return err
}

// readLoop processes incoming WebSocket messages (engine.io ping + socket.io events).
func (c *Client) readLoop(ws *websocket.Conn) error {
	for {
		var msg string
		if err := websocket.Message.Receive(ws, &msg); err != nil {
			return err
		}
		if len(msg) == 0 {
			continue
		}

		switch msg[0] {
		case '2': // engine.io ping → reply pong
			if err := websocket.Message.Send(ws, "3"); err != nil {
				return err
			}
		case '3': // engine.io pong — ignore
		case '4': // socket.io packet
			if err := c.handleSocketIO(msg[1:]); err != nil {
				log.Printf("[node] handle event error: %v", err)
			}
		}
	}
}

// handleSocketIO parses socket.io event/ack packets and dispatches.
func (c *Client) handleSocketIO(payload string) error {
	if len(payload) == 0 {
		return nil
	}

	if strings.HasPrefix(payload, "0") || strings.HasPrefix(payload, "44") {
		return nil // connect ack or connect_error — already handled
	}

	if strings.HasPrefix(payload, "42") {
		// event: 42["eventname",args]
		return c.handleEvent(payload[2:])
	}
	if strings.HasPrefix(payload, "43") {
		// ack: 43<id>[args]
		return c.handleAck(payload[2:])
	}
	if strings.HasPrefix(payload, "41") {
		// disconnect
		return fmt.Errorf("socket.io disconnect from server")
	}
	return nil
}

// handleEvent dispatches a socket.io event by name.
func (c *Client) handleEvent(raw string) error {
	// Parse ["eventname",{...}]
	var parts []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &parts); err != nil {
		return fmt.Errorf("parse event array: %w", err)
	}
	if len(parts) < 2 {
		return nil
	}
	var event string
	if err := json.Unmarshal(parts[0], &event); err != nil {
		return err
	}

	switch event {
	case "node:registered":
		var ack RegisteredAck
		if err := json.Unmarshal(parts[1], &ack); err != nil {
			return err
		}
		c.mu.Lock()
		c.nodeID = ack.NodeID
		c.mu.Unlock()
		log.Printf("[node] registered as nodeId=%s", ack.NodeID)

	case "node:kick":
		if c.OnKick == nil {
			return nil
		}
		var kick NodeKick
		if err := json.Unmarshal(parts[1], &kick); err != nil {
			return err
		}
		go c.OnKick(kick)

	case "recording:delete":
		if c.OnDelete == nil {
			return nil
		}
		var del RecordingDelete
		if err := json.Unmarshal(parts[1], &del); err != nil {
			return err
		}
		go func() {
			if err := c.OnDelete(del); err != nil {
				log.Printf("[node] recording:delete %d: %v", del.RecordingID, err)
			}
		}()

	case "config:limits":
		if c.OnConfig == nil {
			return nil
		}
		var cfg ConfigLimits
		if err := json.Unmarshal(parts[1], &cfg); err != nil {
			return err
		}
		c.OnConfig(cfg)

	default:
		log.Printf("[node] unhandled event: %s", event)
	}
	return nil
}

// handleAck resolves a pending request by ID.
func (c *Client) handleAck(raw string) error {
	// Format: <id>[args]
	idx := strings.Index(raw, "[")
	if idx < 0 {
		return nil
	}
	id := raw[:idx]
	argsStr := raw[idx:]

	chVal, ok := c.pending.LoadAndDelete(id)
	if !ok {
		return nil
	}
	ch := chVal.(chan json.RawMessage)
	select {
	case ch <- json.RawMessage(argsStr):
	default:
	}
	return nil
}

// Emit sends a fire-and-forget event.
func (c *Client) Emit(event string, payload any) error {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return fmt.Errorf("not connected")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	msg := fmt.Sprintf(`42["%s",%s]`, event, data)
	return websocket.Message.Send(ws, msg)
}

// EmitWithAck sends an event and waits for the ack (with timeout).
func (c *Client) EmitWithAck(event string, payload any, result any, timeout time.Duration) error {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return fmt.Errorf("not connected")
	}

	// Generate a unique request ID
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	reqID := hex.EncodeToString(b)

	// Register the pending ack channel
	ch := make(chan json.RawMessage, 1)
	c.pending.Store(reqID, ch)
	defer c.pending.Delete(reqID)

	// Send: 42<reqID>["event",{...}]
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	msg := fmt.Sprintf(`42%s["%s",%s]`, reqID, event, data)
	if err := websocket.Message.Send(ws, msg); err != nil {
		return err
	}

	// Wait for ack
	select {
	case raw := <-ch:
		// Parse the ack args array — the first element is the result
		var parts []json.RawMessage
		if err := json.Unmarshal(raw, &parts); err != nil {
			return fmt.Errorf("parse ack: %w", err)
		}
		if len(parts) > 0 && result != nil {
			return json.Unmarshal(parts[0], result)
		}
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("ack timeout after %v for %s", timeout, event)
	}
}

// wsURL converts the node origin to a WebSocket URL with the socket.io path.
func (c *Client) wsURL() (string, error) {
	u, err := url.Parse(c.nodeOrigin)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}
	u.Path = "/socket"
	// Add engine.io v4 query params
	q := u.Query()
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
