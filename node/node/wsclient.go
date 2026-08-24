// Protobuf-over-WebSocket control client — the modern transport for the
// Node control plane (proto/control/v1/control.proto: one Envelope per
// binary frame; correlated RpcRequest/RpcResponse replace socket.io acks,
// Heartbeat replaces engine.io ping/pong, SDP offers and DVR file chunks
// travel as raw bytes). Selected with CONTROL_TRANSPORT=ws; the socket.io
// Client stays the default during the fleet cutover.
//
// Concurrency: ALL outbound frames funnel through sendEnvelope under
// writeMu — x/net/websocket is NOT safe for concurrent Message.Send (a
// 256KiB recording chunk racing a heartbeat ack interleaves frames and
// corrupts the stream). This includes EmitWithAck — the socket.io client's
// historical bypass of the write lock was a bug, not a pattern.
package node

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/websocket"
	"google.golang.org/protobuf/proto"

	controlv1 "media-node/gen/control/v1"
)

const (
	wsHelloTimeout   = 10 * time.Second
	wsHeartbeatEvery = 25 * time.Second // mirrors engine.io pingInterval
)

// WsClient manages the persistent WebSocket control connection. Its external
// surface matches the socket.io Client (see ControlClient).
type WsClient struct {
	apiOrigin string // Origin header source (the app's HTTP origin)
	wsOrigin  string // dial URL of the control WebSocket (ws://host:31955)
	token     string
	register  RegisterPayload

	mu        sync.Mutex // ws, nodeID, connected
	writeMu   sync.Mutex // serializes ALL outbound frames
	ws        *websocket.Conn
	nodeID    string
	connected bool

	pending sync.Map // seq (uint32) → chan *controlv1.RpcResponse
	nextSeq atomic.Uint32

	// in-flight recording-file streams: reqId → cancel
	recPulls sync.Map

	// command handlers (set via Set* before Run)
	OnKick   func(NodeKick)
	OnConfig func(ConfigLimits)
	OnDelete func(RecordingDelete) error

	// SRS whep base for signaling relays (e.g. http://srs:1985)
	SRSWhepBase string
	// Records dir for recording-file relays
	RecordDir string

	done chan struct{}
}

// NewWsClient creates the protobuf-WS control client. apiOrigin is the app's
// HTTP origin (WS Origin header source); wsOrigin is the control WebSocket
// dial URL — under Bun the app serves it on a dedicated Bun-native port
// (derived from API_ORIGIN with the port swapped, or CONTROL_WS_ORIGIN).
func NewWsClient(apiOrigin, wsOrigin, token string, reg RegisterPayload) *WsClient {
	return &WsClient{
		apiOrigin: apiOrigin,
		wsOrigin:  wsOrigin,
		token:     token,
		register:  reg,
		done:      make(chan struct{}),
	}
}

func (c *WsClient) NodeID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nodeID
}

func (c *WsClient) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

func (c *WsClient) SetOnKick(f func(NodeKick))                { c.OnKick = f }
func (c *WsClient) SetOnConfig(f func(ConfigLimits))          { c.OnConfig = f }
func (c *WsClient) SetOnDelete(f func(RecordingDelete) error) { c.OnDelete = f }

// Run starts the connection loop: dial → hello/hello_ack → serve frames →
// reconnect on drop (fixed 3s, matching the socket.io client's proven loop).
func (c *WsClient) Run() {
	for {
		select {
		case <-c.done:
			return
		default:
		}
		if err := c.connectOnce(); err != nil {
			log.Printf("[ws] connection error: %v (retrying in 3s)", err)
			select {
			case <-time.After(3 * time.Second):
			case <-c.done:
				return
			}
		}
	}
}

// Close shuts down the connection loop.
func (c *WsClient) Close() {
	close(c.done)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ws != nil {
		_ = c.ws.Close()
	}
}

// markDead clears connection bookkeeping so sendEnvelope fails fast with
// "not connected" instead of writing to a dead socket.
func (c *WsClient) markDead(ws *websocket.Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.connected = false
	if c.ws == ws {
		c.ws = nil
	}
}

// sendEnvelope is the ONLY writer. All outbound frames go through here.
func (c *WsClient) sendEnvelope(env *controlv1.Envelope) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return fmt.Errorf("not connected")
	}
	data, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	return websocket.Message.Send(ws, data)
}

// connectOnce dials, authenticates with Hello (the shared token rides the
// first frame), waits for hello_ack, then serves frames until the
// connection drops.
func (c *WsClient) connectOnce() error {
	wsURL, err := c.wsURL()
	if err != nil {
		return fmt.Errorf("build ws url: %w", err)
	}
	ws, err := dialWebsocket(c.apiOrigin, wsURL)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}

	c.mu.Lock()
	c.ws = ws
	c.connected = true
	c.mu.Unlock()

	reg := c.register
	hello := &controlv1.Hello{
		Identifier: reg.Identifier,
		Hostname:   reg.Hostname,
		Version:    reg.Version,
		AuthToken:  c.token,
		Endpoints: &controlv1.CMsgPublicEndpoints{
			PublicOrigin:       reg.PublicOrigin,
			PublicRtmpPort:     int32(reg.PublicRTMPPort),
			PublicProbeUdpPort: int32(reg.PublicProbeUDPPort),
			PublicSrsUdpPort:   int32(reg.PublicSrsUDPPort),
			SrsFlvBase:         reg.SRSFlvBase,
		},
	}
	if err := c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_Hello{Hello: hello}}); err != nil {
		c.markDead(ws)
		return fmt.Errorf("send hello: %w", err)
	}

	// Wait for hello_ack (bounded — a server that upgrades but never speaks
	// must not wedge the client).
	_ = ws.SetReadDeadline(time.Now().Add(wsHelloTimeout))
	var buf []byte
	if err := websocket.Message.Receive(ws, &buf); err != nil {
		c.markDead(ws)
		return fmt.Errorf("read hello ack: %w", err)
	}
	var env controlv1.Envelope
	if err := proto.Unmarshal(buf, &env); err != nil {
		c.markDead(ws)
		return fmt.Errorf("decode hello ack: %w", err)
	}
	ack, ok := env.Kind.(*controlv1.Envelope_HelloAck)
	if !ok {
		c.markDead(ws)
		return fmt.Errorf("expected hello_ack, got %T", env.Kind)
	}
	c.mu.Lock()
	c.nodeID = ack.HelloAck.NodeId
	c.mu.Unlock()
	log.Printf("[ws] connected %s/ws/media-node — registered as nodeId=%s", c.apiOrigin, ack.HelloAck.NodeId)

	// Heartbeat: 25s ticker in its own goroutine; any send error (dead link)
	// ends it, and readLoop's 90s deadline forces the reconnect.
	go func() {
		t := time.NewTicker(wsHeartbeatEvery)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				hb := &controlv1.Envelope{Kind: &controlv1.Envelope_Heartbeat{
					Heartbeat: &controlv1.Heartbeat{SentAtMs: time.Now().UnixMilli()},
				}}
				if err := c.sendEnvelope(hb); err != nil {
					return
				}
			case <-c.done:
				return
			}
		}
	}()

	err = c.readLoop(ws)
	c.markDead(ws)
	log.Printf("[ws] disconnected: %v", err)
	return err
}

// readLoop processes incoming binary frames. Every read is deadline-bounded:
// heartbeat acks (and any frame) refresh it; exceeding readDeadline (90s)
// means the link died silently — bail so Run() reconnects.
func (c *WsClient) readLoop(ws *websocket.Conn) error {
	for {
		_ = ws.SetReadDeadline(time.Now().Add(readDeadline))
		var buf []byte
		if err := websocket.Message.Receive(ws, &buf); err != nil {
			return err
		}
		var env controlv1.Envelope
		if err := proto.Unmarshal(buf, &env); err != nil {
			log.Printf("[ws] undecodable frame (%d bytes): %v", len(buf), err)
			continue
		}
		c.dispatch(&env)
	}
}

func (c *WsClient) dispatch(env *controlv1.Envelope) {
	switch kind := env.Kind.(type) {
	case *controlv1.Envelope_HelloAck:
		c.mu.Lock()
		c.nodeID = kind.HelloAck.NodeId
		c.mu.Unlock()

	case *controlv1.Envelope_Heartbeat:
		ack := &controlv1.Envelope{Kind: &controlv1.Envelope_HeartbeatAck{
			HeartbeatAck: &controlv1.HeartbeatAck{EchoedSentAtMs: kind.Heartbeat.SentAtMs},
		}}
		if err := c.sendEnvelope(ack); err != nil {
			log.Printf("[ws] heartbeat ack failed: %v", err)
		}

	case *controlv1.Envelope_HeartbeatAck:
		// RTT could be computed here if ever needed

	case *controlv1.Envelope_RpcResponse:
		seq := kind.RpcResponse.Seq
		if chVal, ok := c.pending.LoadAndDelete(seq); ok {
			ch := chVal.(chan *controlv1.RpcResponse)
			select {
			case ch <- kind.RpcResponse:
			default:
			}
		}

	case *controlv1.Envelope_RpcRequest:
		c.handleIncomingRPC(kind.RpcRequest)

	// app → node push frames (flattened into the Envelope oneof — the case
	// name is the dispatch key, the protobuf equivalent of a hub method name)
	case *controlv1.Envelope_KickStream:
		if c.OnKick != nil {
			go c.OnKick(NodeKick{
				StreamName: kind.KickStream.StreamName,
				Reason:     kind.KickStream.Reason,
			})
		}

	case *controlv1.Envelope_LimitsConfig:
		if c.OnConfig != nil {
			cfg := ConfigLimits{Events: []EventLimits{}}
			if kind.LimitsConfig.Global != nil {
				cfg.Global = limitsFromProto(kind.LimitsConfig.Global)
			}
			for _, e := range kind.LimitsConfig.Events {
				el := EventLimits{EventID: e.EventId}
				if e.Limits != nil {
					el.Limits = limitsFromProto(e.Limits)
				}
				cfg.Events = append(cfg.Events, el)
			}
			c.OnConfig(cfg)
		}

	case *controlv1.Envelope_RecordingDelete:
		if c.OnDelete != nil {
			del := RecordingDelete{Segments: kind.RecordingDelete.RelPaths}
			go func() {
				if err := c.OnDelete(del); err != nil {
					log.Printf("[ws] recording delete: %v", err)
				}
			}()
		}

	case *controlv1.Envelope_RecordingCancel:
		if cancel, ok := c.recPulls.LoadAndDelete(kind.RecordingCancel.ReqId); ok {
			cancel.(context.CancelFunc)()
		}

	default:
		log.Printf("[ws] unexpected envelope kind: %T", env.Kind)
	}
}

func limitsFromProto(l *controlv1.CMsgLimits) Limits {
	return Limits{
		MaxWidth:            int(l.MaxWidth),
		MaxHeight:           int(l.MaxHeight),
		MaxFps:              int(l.MaxFps),
		MaxVideoBitrateKbps: int(l.MaxVideoBitrateKbps),
		MaxAudioBitrateKbps: int(l.MaxAudioBitrateKbps),
	}
}

func limitsToProto(l *Limits) *controlv1.CMsgLimits {
	if l == nil {
		return nil
	}
	return &controlv1.CMsgLimits{
		MaxWidth:            int32(l.MaxWidth),
		MaxHeight:           int32(l.MaxHeight),
		MaxFps:              int32(l.MaxFps),
		MaxVideoBitrateKbps: int32(l.MaxVideoBitrateKbps),
		MaxAudioBitrateKbps: int32(l.MaxAudioBitrateKbps),
	}
}

/* --------------------- node → app: reports and RPCs --------------------- */

// Emit sends a fire-and-forget report (same call shape as the socket.io
// client, so callers stay transport-agnostic — payload is one of the report
// structs, type-switched to its protobuf event).
func (c *WsClient) Emit(event string, payload any) error {
	switch p := payload.(type) {
	case MetricsReport:
		return c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_PublishMetrics{PublishMetrics: &controlv1.PublishMetricsMessage{
			SessionId:        p.SessionID,
			Width:            i32p(p.Width),
			Height:           i32p(p.Height),
			Fps:              f64p(p.Fps),
			VideoBitrateKbps: i32p(p.VideoBitrateKbps),
			AudioBitrateKbps: i32p(p.AudioBitrateKbps),
		}}})

	case ViolationReport:
		v := &controlv1.PublishViolationMessage{SessionId: p.SessionID, Reasons: p.Reasons}
		if p.Metrics != nil {
			v.Metrics = &controlv1.PublishMetricsMessage{
				SessionId:        p.Metrics.SessionID,
				Width:            i32p(p.Metrics.Width),
				Height:           i32p(p.Metrics.Height),
				Fps:              f64p(p.Metrics.Fps),
				VideoBitrateKbps: i32p(p.Metrics.VideoBitrateKbps),
				AudioBitrateKbps: i32p(p.Metrics.AudioBitrateKbps),
			}
		}
		return c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_PublishViolation{PublishViolation: v}})

	case EndReport:
		return c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_PublishEnded{PublishEnded: &controlv1.PublishEndedMessage{
			SessionId:   p.SessionID,
			EndedAtMs:   p.EndedAt,
			DurationSec: int32(p.DurationSec),
		}}})

	case RecordingReady:
		r := &controlv1.RecordingReadyMessage{
			NodeId:      p.NodeID,
			StreamName:  p.StreamName,
			EventId:     p.EventID,
			SessionId:   i64p(p.SessionID),
			SizeBytes:   p.SizeBytes,
			DurationSec: int32(p.DurationSec),
			AvgFps:      f64p(p.AvgFps),
			Width:       i32p(p.Width),
			Height:      i32p(p.Height),
		}
		for _, s := range p.Segments {
			r.Segments = append(r.Segments, &controlv1.CMsgRecordingSegment{
				RelPath:     s.RelPath,
				SizeBytes:   s.SizeBytes,
				DurationSec: int32(s.DurationSec),
			})
		}
		return c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_RecordingReady{RecordingReady: r}})

	default:
		return fmt.Errorf("ws transport: unsupported emit payload %T for %s", payload, event)
	}
}

// EmitWithAck sends an RPC and unmarshals the response into result (same
// call shape as the socket.io client — event names are the legacy ones so
// auth.go and the RTMP gate stay transport-agnostic).
func (c *WsClient) EmitWithAck(event string, payload any, result any, timeout time.Duration) error {
	var body any
	switch event {
	case "publish:start":
		p := payload.(PublishStart)
		body = &controlv1.AuthorizePublishRequest{
			NodeId:      p.NodeID,
			StreamName:  p.StreamName,
			Token:       p.Token,
			AuthedUser:  p.AuthedUser,
			SrsClientId: p.SRSClientID,
		}
	case "publish:spec":
		p := payload.(PublishSpec)
		body = &controlv1.JudgeSpecRequest{
			NodeId:           p.NodeID,
			StreamName:       p.StreamName,
			Width:            i32p(p.Width),
			Height:           i32p(p.Height),
			Fps:              f64p(p.Fps),
			VideoKbps:        f64p(p.VideoKbps),
			AudioBitrateKbps: f64p(p.AudioBitrateKbps),
		}
	case "auth:salt":
		m := payload.(map[string]string)
		body = &controlv1.AuthSaltRequest{Email: m["email"]}
	case "auth:verify":
		m := payload.(map[string]string)
		body = &controlv1.AuthVerifyRequest{
			Email: m["email"], Opaque: m["opaque"], Challenge: m["challenge"], Response: m["response"],
		}
	case "auth:policy":
		m := payload.(map[string]string)
		body = &controlv1.AuthPolicyRequest{Token: m["token"], Stream: m["stream"]}
	default:
		return fmt.Errorf("ws transport: unsupported ack event %s", event)
	}

	resp, err := c.rpcCall(body, timeout)
	if err != nil {
		return err
	}
	return rpcResultToJSON(resp, result)
}

// rpcCall registers the pending response channel BEFORE sending (no
// socket.io-style numeric-string id constraints — seq is a plain counter).
func (c *WsClient) rpcCall(body any, timeout time.Duration) (*controlv1.RpcResponse, error) {
	seq := c.nextSeq.Add(1)
	req := &controlv1.RpcRequest{Seq: seq}
	switch b := body.(type) {
	case *controlv1.AuthorizePublishRequest:
		req.Body = &controlv1.RpcRequest_AuthorizePublish{AuthorizePublish: b}
	case *controlv1.JudgeSpecRequest:
		req.Body = &controlv1.RpcRequest_JudgeSpec{JudgeSpec: b}
	case *controlv1.AuthSaltRequest:
		req.Body = &controlv1.RpcRequest_AuthSalt{AuthSalt: b}
	case *controlv1.AuthVerifyRequest:
		req.Body = &controlv1.RpcRequest_AuthVerify{AuthVerify: b}
	case *controlv1.AuthPolicyRequest:
		req.Body = &controlv1.RpcRequest_AuthPolicy{AuthPolicy: b}
	default:
		return nil, fmt.Errorf("ws transport: unsupported rpc body %T", body)
	}

	ch := make(chan *controlv1.RpcResponse, 1)
	c.pending.Store(seq, ch)
	defer c.pending.Delete(seq)

	if err := c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_RpcRequest{RpcRequest: req}}); err != nil {
		return nil, err
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("rpc timeout after %v", timeout)
	case <-c.done:
		return nil, fmt.Errorf("shutting down")
	}
}

// rpcResultToJSON converts an RPC response body into the legacy JSON shape
// and unmarshals it into result — callers keep their existing structs and
// json tags untouched.
func rpcResultToJSON(resp *controlv1.RpcResponse, result any) error {
	var m map[string]any
	switch b := resp.Body.(type) {
	case *controlv1.RpcResponse_AuthorizePublish:
		r := b.AuthorizePublish
		m = map[string]any{"allow": r.Allow, "record": r.Record, "strict": r.Strict, "measured": r.Measured}
		if r.Reason != "" {
			m["reason"] = r.Reason
		}
		if r.SessionId != 0 {
			m["sessionId"] = r.SessionId
		}
		if r.EventId != nil {
			m["eventId"] = *r.EventId
		}
		if r.EventKey != "" {
			m["eventKey"] = r.EventKey
		}
		if r.Limits != nil {
			m["limits"] = map[string]any{
				"maxWidth": r.Limits.MaxWidth, "maxHeight": r.Limits.MaxHeight, "maxFps": r.Limits.MaxFps,
				"maxVideoBitrateKbps": r.Limits.MaxVideoBitrateKbps, "maxAudioBitrateKbps": r.Limits.MaxAudioBitrateKbps,
			}
		}
	case *controlv1.RpcResponse_JudgeSpec:
		m = map[string]any{"allow": b.JudgeSpec.Allow}
		if b.JudgeSpec.Reason != "" {
			m["reason"] = b.JudgeSpec.Reason
		}
	case *controlv1.RpcResponse_AuthSalt:
		m = map[string]any{"salt": b.AuthSalt.Salt, "banned": b.AuthSalt.Banned}
	case *controlv1.RpcResponse_AuthVerify:
		m = map[string]any{"allow": b.AuthVerify.Allow, "known": b.AuthVerify.Known}
	case *controlv1.RpcResponse_AuthPolicy:
		m = map[string]any{
			"publishKey": b.AuthPolicy.PublishKey, "requireAccountAuth": b.AuthPolicy.RequireAccountAuth,
			"windowOpen": b.AuthPolicy.WindowOpen, "banned": b.AuthPolicy.Banned,
		}
	case *controlv1.RpcResponse_Error:
		return fmt.Errorf("control plane: %s", b.Error.Message)
	default:
		return fmt.Errorf("unexpected rpc response %T", resp.Body)
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, result)
}

/* --------------------- RTMP authmod (same semantics as auth.go) --------------------- */

func (c *WsClient) ackRetry(event string, payload any, result any, attempts int, timeout time.Duration) error {
	var err error = fmt.Errorf("no attempts")
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		if err = c.EmitWithAck(event, payload, result, timeout); err == nil {
			return nil
		}
	}
	return err
}

func (c *WsClient) Salt(email string) SaltResult {
	var ack struct {
		Salt   string `json:"salt"`
		Banned bool   `json:"banned"`
	}
	err := c.ackRetry("auth:salt", map[string]string{"email": email}, &ack, 2, 3*time.Second)
	if err != nil || ack.Salt == "" {
		return SaltResult{Salt: randomHex(8)}
	}
	return SaltResult{Salt: ack.Salt, Banned: ack.Banned}
}

func (c *WsClient) Verify(email, opaque, challenge, response string) VerifyResult {
	var ack struct {
		Allow bool `json:"allow"`
		Known bool `json:"known"`
	}
	err := c.ackRetry("auth:verify", map[string]string{
		"email": email, "opaque": opaque, "challenge": challenge, "response": response,
	}, &ack, 2, 3*time.Second)
	if err != nil {
		log.Printf("[ws] auth:verify unreachable after retries: %v", err)
		return VerifyResult{}
	}
	return VerifyResult{Allow: ack.Allow, Known: ack.Known}
}

func (c *WsClient) Policy(token, stream string) PolicyResult {
	var ack struct {
		PublishKey         bool `json:"publishKey"`
		RequireAccountAuth bool `json:"requireAccountAuth"`
		WindowOpen         bool `json:"windowOpen"`
		Banned             bool `json:"banned"`
	}
	if err := c.ackRetry("auth:policy", map[string]string{"token": token, "stream": stream}, &ack, 3, 3*time.Second); err != nil {
		log.Printf("[ws] auth:policy unreachable after retries: %v", err)
		return PolicyResult{Unreachable: true}
	}
	return PolicyResult{
		PublishKey:         ack.PublishKey,
		RequireAccountAuth: ack.RequireAccountAuth,
		WindowOpen:         ack.WindowOpen,
		Banned:             ack.Banned,
	}
}

func (c *WsClient) VerifySpec(p PublishSpec) (SpecVerdict, error) {
	var ack SpecVerdict
	err := c.EmitWithAck("publish:spec", p, &ack, 5*time.Second)
	return ack, err
}

/* --------------------- app → node RPCs: WHEP + recording pull --------------------- */

func (c *WsClient) respondRPC(seq uint32, body any) {
	resp := &controlv1.RpcResponse{Seq: seq}
	switch b := body.(type) {
	case *controlv1.WhepRelayResponse:
		resp.Body = &controlv1.RpcResponse_WhepRelay{WhepRelay: b}
	case *controlv1.RecordingPullResponse:
		resp.Body = &controlv1.RpcResponse_RecordingPull{RecordingPull: b}
	case *controlv1.Error:
		resp.Body = &controlv1.RpcResponse_Error{Error: b}
	default:
		resp.Body = &controlv1.RpcResponse_Error{Error: &controlv1.Error{Message: fmt.Sprintf("unsupported response %T", body)}}
	}
	if err := c.sendEnvelope(&controlv1.Envelope{Kind: &controlv1.Envelope_RpcResponse{RpcResponse: resp}}); err != nil {
		log.Printf("[ws] rpc response send failed: %v", err)
	}
}

// handleIncomingRPC answers the two app-initiated RPCs. Both handlers run in
// goroutines — an HTTP round trip (WHEP) or a multi-second file transfer
// must never stall the read loop.
func (c *WsClient) handleIncomingRPC(req *controlv1.RpcRequest) {
	switch body := req.Body.(type) {
	case *controlv1.RpcRequest_WhepRelay:
		go func() {
			w := body.WhepRelay
			answer, errStr := whepRelayHTTP(c.SRSWhepBase, w.StreamName, w.OfferSdp)
			c.respondRPC(req.Seq, &controlv1.WhepRelayResponse{
				AnswerSdp: []byte(answer),
				Error:     errStr,
			})
		}()

	case *controlv1.RpcRequest_RecordingPull:
		p := body.RecordingPull
		go func() {
			// ALWAYS end the transfer (clean EOF included) — the app waits
			// for this to finish the download; silence = stall.
			end := &controlv1.RecordingStreamEndMessage{ReqId: p.ReqId}
			if err := c.streamFileWS(p.ReqId, p.RelPath); err != nil {
				end.Error = err.Error()
			}
			ev := &controlv1.Envelope{Kind: &controlv1.Envelope_RecordingStreamEnd{RecordingStreamEnd: end}}
			if e := c.sendEnvelope(ev); e != nil {
				log.Printf("[rec] end send failed: %v", e)
			}
		}()
		c.respondRPC(req.Seq, &controlv1.RecordingPullResponse{Started: true})

	default:
		log.Printf("[ws] unsupported rpc request: %T", req.Body)
		c.respondRPC(req.Seq, &controlv1.Error{Message: fmt.Sprintf("unsupported rpc %T", req.Body)})
	}
}

// streamFileWS relays one recording file as raw-bytes recording_chunk events
// (256KiB chunks, 2GiB cap — same bounds as the socket.io relay, minus the
// base64 inflation).
func (c *WsClient) streamFileWS(reqId, relPath string) error {
	if c.RecordDir == "" {
		return fmt.Errorf("node has no records dir configured")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.recPulls.Store(reqId, context.CancelFunc(cancel))
	defer c.recPulls.Delete(reqId)
	return relayFile(c.RecordDir, relPath, func(b []byte) error {
		ev := &controlv1.Envelope{Kind: &controlv1.Envelope_RecordingChunk{
			RecordingChunk: &controlv1.RecordingChunkMessage{ReqId: reqId, Data: b},
		}}
		return c.sendEnvelope(ev)
	}, func() bool { return ctx.Err() != nil })
}

// wsURL normalizes the configured control-WS origin into the dial URL.
func (c *WsClient) wsURL() (string, error) {
	u, err := url.Parse(c.wsOrigin)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}
	u.Path = "/ws/media-node"
	u.RawQuery = ""
	return u.String(), nil
}

/* --------------------- optional-field helpers --------------------- */

// proto3 `optional` scalars map to pointers; the report structs use
// omitempty-style zero-means-absent, mirrored here.
func i32p(v int) *int32 {
	if v == 0 {
		return nil
	}
	x := int32(v)
	return &x
}

func i64p(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}

func f64p(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}
