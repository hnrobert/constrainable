// Hand-rolled minimal Engine.IO v4 + Socket.IO v5 client over WebSocket.
// The wire protocol is tiny: engine.io open/ping-pong, socket.io connect/event/ack.
// This avoids dragging in a third-party dependency with a different EIO version.
package node

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/websocket"
)

// The socket.io namespace ALL control-plane traffic rides on. Outgoing event
// frames MUST carry it (`42/media-node,["event",…]`) — without it packets land
// on the root namespace, which we never CONNECT to, and the server treats that
// as a protocol violation and force-closes the socket.
const nsp = "/media-node"

// Liveness: engine.io pings every 25s (pingInterval) — a link silent longer
// than readDeadline is dead (half-open TCP/blackholed NAT: no FIN ever
// arrives, so WITHOUT a deadline the client would wait forever and never
// reconnect). Handshake reads get a much shorter budget.
const (
	connectAckTimeout = 10 * time.Second
	readDeadline      = 90 * time.Second
)

// Client manages the persistent Socket.IO connection to the Node control plane.
type Client struct {
	apiOrigin string // e.g. http://constrainable-app:31954
	token     string
	register  RegisterPayload

	mu        sync.Mutex
	ws        *websocket.Conn
	nodeID    string
	connected bool

	// pending acks: requestID → channel. IDs MUST be NUMERIC strings —
	// socket.io's parser reads packet ids as an integer run; a hex id with
	// letters is an invalid packet and the server force-closes the socket.
	pending sync.Map
	nextID  atomic.Uint64

	// event handlers (set by the owner before Connect)
	OnKick   func(NodeKick)
	OnDelete func(RecordingDelete) error

	// SRS whep base for signaling relays (e.g. http://srs:1985) — set by the
	// owner from SRSApiBase before Connect; empty disables node:whep.
	SRSWhepBase string
	OnConfig func(ConfigLimits)

	reconnectCh chan struct{}
	done        chan struct{}
}

// NewClient creates a Socket.IO client for the Node control plane
// (apiOrigin = the constrainable-app URL, env API_ORIGIN).
func NewClient(apiOrigin, token string, reg RegisterPayload) *Client {
	return &Client{
		apiOrigin:   strings.TrimRight(apiOrigin, "/"),
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

// markDead clears the connection bookkeeping when a socket dies, so Emit
// fails fast with "not connected" instead of writing to a dead socket.
func (c *Client) markDead(ws *websocket.Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.connected = false
	if c.ws == ws {
		c.ws = nil
	}
}

// warmAttach primes the app's LAZY socket.io attach: it hooks the HTTP
// server on the first REGULAR request, and a websocket UPGRADE arriving
// before any HTTP request is dropped by Node (no upgrade listener yet). One
// cheap health GET before dialing guarantees the attach exists — fixes
// cold-start connect failures against a freshly booted app.
func (c *Client) warmAttach() {
	req, err := http.NewRequest(http.MethodGet, c.apiOrigin+"/api/health", nil)
	if err != nil {
		return
	}
	hc := &http.Client{Timeout: 3 * time.Second}
	resp, err := hc.Do(req)
	if err == nil {
		_ = resp.Body.Close()
	}
}

// connectOnce establishes a WebSocket, performs the engine.io + socket.io
// handshake, registers, and reads events until the connection drops.
func (c *Client) connectOnce() error {
	// Build the engine.io polling handshake URL (we need the session ID).
	// For simplicity, we use the websocket transport directly.
	c.warmAttach()

	wsURL, err := c.wsURL()
	if err != nil {
		return fmt.Errorf("build ws url: %w", err)
	}

	ws, err := c.wsDial(wsURL)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}

	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()

	// Send engine.io OPEN is implicit with websocket transport (server sends "0{sid}")
	// Read the engine.io open packet (bounded: a server that accepts TCP but
	// never speaks must not wedge the client)
	var msg string
	_ = ws.SetReadDeadline(time.Now().Add(connectAckTimeout))
	if err := websocket.Message.Receive(ws, &msg); err != nil {
		c.markDead(ws)
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

	// Read the socket.io CONNECT ack: 40/media-node, (same bound)
	_ = ws.SetReadDeadline(time.Now().Add(connectAckTimeout))
	if err := websocket.Message.Receive(ws, &msg); err != nil {
		c.markDead(ws)
		return fmt.Errorf("read socket.io connect ack: %w", err)
	}
	if !strings.HasPrefix(msg, "40/media-node") {
		return fmt.Errorf("expected socket.io connect ack, got %q", msg[:min(len(msg), 40)])
	}

	c.mu.Lock()
	c.connected = true
	c.mu.Unlock()
	log.Printf("[node] connected to %s/media-node", c.apiOrigin)

	// Register
	regData, _ := json.Marshal(c.register)
	regMsg := fmt.Sprintf("42%s,[\"node:register\",%s]", nsp, regData)
	if err := websocket.Message.Send(ws, regMsg); err != nil {
		return fmt.Errorf("send register: %w", err)
	}

	// Read events until disconnect
	err = c.readLoop(ws)

	c.markDead(ws)
	log.Printf("[node] disconnected: %v", err)
	return err
}

// readLoop processes incoming WebSocket messages (engine.io ping + socket.io
// events). Every read is deadline-bounded: a healthy link delivers a server
// ping at least every 25s, so exceeding readDeadline means the link died
// silently — bail so Run() reconnects instead of waiting on a dead socket.
func (c *Client) readLoop(ws *websocket.Conn) error {
	for {
		_ = ws.SetReadDeadline(time.Now().Add(readDeadline))
		var msg string
		if err := websocket.Message.Receive(ws, &msg); err != nil {
			c.markDead(ws)
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

// handleSocketIO parses socket.io packets (engine '4' already stripped) and
// dispatches. Wire format per the socket.io parser: type + ["/nsp,"] + [id] +
// JSON — the namespace may precede the id on events AND acks, so strip it
// uniformly before looking at the rest.
func (c *Client) handleSocketIO(payload string) error {
	if len(payload) == 0 {
		return nil
	}
	rest := payload[1:]
	if strings.HasPrefix(rest, "/") {
		if i := strings.Index(rest, ","); i >= 0 {
			rest = rest[i+1:]
		}
	}

	switch payload[0] {
	case '0': // connect ack — handled in connectOnce
		return nil
	case '1': // disconnect packet
		return fmt.Errorf("socket.io disconnect from server")
	case '2': // event: [<id>]["eventname",args] — the id is present when the
		// sender expects an ack back; keep it so the handler can reply.
		reqID := ""
		if len(rest) > 0 && rest[0] >= '0' && rest[0] <= '9' {
			i := 0
			for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
				i++
			}
			reqID = rest[:i]
			rest = rest[i:]
		}
		return c.handleEvent(rest, reqID)
	case '3': // ack: <id>[args]
		return c.handleAck(rest)
	case '4': // error packets (44 connect_error is handled at connect time)
		log.Printf("[node] socket.io error packet: %s", payload)
		return nil
	}
	return nil
}

// handleEvent dispatches a socket.io event by name. reqID is the socket.io
// packet id when the server expects an ack ("" for fire-and-forget events).
func (c *Client) handleEvent(raw, reqID string) error {
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

	// Latency probe from the control plane: echo the payload back as a
	// socket.io CLIENT-ACK frame (45<nsp>,<id>[args]) so the app can measure
	// the round trip. Firmware without this handler simply never acks — the
	// app shows "n/a" for those nodes until they update.
	if event == "node:ping" && reqID != "" {
		c.mu.Lock()
		ws := c.ws
		c.mu.Unlock()
		if ws == nil {
			return nil
		}
		// socket.io v5 ACK wire form: engine '4' + packet '3' → 43<nsp>,<id>[args]
		reply := fmt.Sprintf("43%s,%s[%s]", nsp, reqID, string(parts[1]))
		return websocket.Message.Send(ws, reply)
	}

	// WHEP signaling relay: the control plane cannot reach this node's SRS
	// HTTP API (deliberately never published), so browsers' playback offers
	// are forwarded here. POST to the colocated SRS, ack with the answer SDP.
	// Runs in a goroutine — the HTTP round trip must not stall the read loop;
	// the ack frame is written when it completes.
	if event == "node:whep" && reqID != "" {
		var relay WhepRelay
		if err := json.Unmarshal(parts[1], &relay); err != nil {
			return err
		}
		go func() {
			out := c.relayWhep(relay)
			data, err := json.Marshal(out)
			if err != nil {
				return
			}
			c.mu.Lock()
			ws := c.ws
			c.mu.Unlock()
			if ws == nil {
				return
			}
			reply := fmt.Sprintf("43%s,%s[%s]", nsp, reqID, data)
			_ = websocket.Message.Send(ws, reply)
		}()
		return nil
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

// relayWhep forwards a browser's WHEP offer to this node's colocated SRS and
// returns the ack payload: {answer} on 201, {error} otherwise.
func (c *Client) relayWhep(r WhepRelay) map[string]string {
	if c.SRSWhepBase == "" {
		return map[string]string{"error": "node has no SRS API base configured"}
	}
	q := url.Values{}
	q.Set("app", "live")
	q.Set("stream", r.StreamName)
	target := strings.TrimRight(c.SRSWhepBase, "/") + "/rtc/v1/whep/?" + q.Encode()
	resp, err := http.Post(target, "application/sdp", strings.NewReader(r.Offer))
	if err != nil {
		return map[string]string{"error": "srs unreachable: " + err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 {
		return map[string]string{"error": fmt.Sprintf("srs whep responded %d: %.200s", resp.StatusCode, string(body))}
	}
	return map[string]string{"answer": string(body)}
}

// Emit sends a fire-and-forget event (namespaced: 42<nsp>,["event",payload]).
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
	msg := fmt.Sprintf("42%s,[\"%s\",%s]", nsp, event, data)
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

	// Numeric request id (protocol requirement — see nextID comment)
	reqID := strconv.FormatUint(c.nextID.Add(1), 10)

	// Register the pending ack channel
	ch := make(chan json.RawMessage, 1)
	c.pending.Store(reqID, ch)
	defer c.pending.Delete(reqID)

	// Send: 42<nsp>,<reqID>["event",{...}] (namespace BEFORE the id — the
	// parser's encode order is type, namespace, id, payload)
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	msg := fmt.Sprintf("42%s,%s[\"%s\",%s]", nsp, reqID, event, data)
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

// wsDial dials the WebSocket with the ENTIRE handshake under a deadline:
// we own the TCP conn, bound it with SetDeadline (covers the HTTP 101
// upgrade read too — websocket.Dial would block forever on a server that
// accepts TCP but never speaks), then hand it to websocket.NewClient and
// clear the deadline so readLoop can apply its own per-read bounds.
func (c *Client) wsDial(wsURL string) (*websocket.Conn, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	hostPort := u.Host
	if u.Port() == "" {
		defPort := "80"
		if u.Scheme == "wss" {
			defPort = "443"
		}
		hostPort = net.JoinHostPort(u.Hostname(), defPort)
	}

	dialer := &net.Dialer{Timeout: connectAckTimeout}
	var conn net.Conn
	if u.Scheme == "wss" {
		conn, err = tls.DialWithDialer(dialer, "tcp", hostPort, &tls.Config{ServerName: u.Hostname()})
	} else {
		conn, err = dialer.Dial("tcp", hostPort)
	}
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(connectAckTimeout))

	cfg, err := websocket.NewConfig(wsURL, c.apiOrigin)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	ws, err := websocket.NewClient(cfg, conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{}) // per-read deadlines take over
	return ws, nil
}

// wsURL converts the node origin to a WebSocket URL with the socket.io path.
func (c *Client) wsURL() (string, error) {
	u, err := url.Parse(c.apiOrigin)
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
	// Trailing slash matters behind reverse proxies: engine.io's canonical
	// path is /socket/ and proxies commonly route ONLY the slashed form —
	// /socket (no slash) gets redirected/502'd, which kills the WS dial
	// (browsers' engine.io clients always use the slashed form).
	u.Path = "/socket/"
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
