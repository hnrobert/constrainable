// Auth over Socket.IO: salt / verify / policy — the same wire data as the HTTP
// endpoints, but carried as socket events with acks instead of HTTP requests.
// This eliminates the media-node's only HTTP dependency on the Node control
// plane; ALL communication rides the single Socket.IO connection.
package node

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"time"
)

// SaltViaSocket asks Node for the user's authmod salt (stage 2).
func (c *Client) Salt(email string) SaltResult {
	var ack struct {
		Salt   string `json:"salt"`
		Banned bool   `json:"banned"`
	}
	err := c.ackWithRetry("auth:salt", map[string]string{"email": email}, &ack, 2, 3*time.Second)
	if err != nil || ack.Salt == "" {
		return SaltResult{Salt: randomHex(8)}
	}
	return SaltResult{Salt: ack.Salt, Banned: ack.Banned}
}

// VerifyViaSocket asks Node to check the authmod response (stage 3).
func (c *Client) Verify(email, opaque, challenge, response string) VerifyResult {
	var ack struct {
		Allow bool `json:"allow"`
		Known bool `json:"known"`
	}
	err := c.ackWithRetry("auth:verify", map[string]string{
		"email": email, "opaque": opaque, "challenge": challenge, "response": response,
	}, &ack, 2, 3*time.Second)
	if err != nil {
		log.Printf("[node] auth:verify unreachable after retries: %v", err)
		return VerifyResult{}
	}
	return VerifyResult{Allow: ack.Allow, Known: ack.Known}
}

// ackWithRetry runs EmitWithAck with retries — the control-plane socket
// reconnects with a short gap after drops, and a TRANSIENT link failure must
// never read as a negative answer (e.g. policy zero-values = "unknown key").
// Returns the last error when every attempt fails.
func (c *Client) ackWithRetry(event string, payload any, result any, attempts int, timeout time.Duration) error {
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

// PolicyViaSocket asks Node how to treat a publish token + stream name.
// Retried: an unreachable control plane yields Unreachable=true (the caller
// must close WITHOUT a terminal OBS error), never "unknown key".
func (c *Client) Policy(token, stream string) PolicyResult {
	var ack struct {
		PublishKey         bool `json:"publishKey"`
		RequireAccountAuth bool `json:"requireAccountAuth"`
		WindowOpen         bool `json:"windowOpen"`
		Banned             bool `json:"banned"`
	}
	if err := c.ackWithRetry("auth:policy", map[string]string{"token": token, "stream": stream}, &ack, 3, 3*time.Second); err != nil {
		log.Printf("[node] auth:policy unreachable after retries: %v", err)
		return PolicyResult{Unreachable: true}
	}
	return PolicyResult{
		PublishKey:         ack.PublishKey,
		RequireAccountAuth: ack.RequireAccountAuth,
		WindowOpen:         ack.WindowOpen,
		Banned:             ack.Banned,
	}
}

// PlayAuth asks the control plane whether a direct browser FLV pull on this
// node is authorized (signed playback URL, 5s fail-closed timeout).
func (c *Client) PlayAuth(p PlayAuth) (PlayAuthAck, error) {
	var ack PlayAuthAck
	err := c.EmitWithAck("play:auth", map[string]any{
		"stream": p.Stream, "exp": p.Exp, "sig": p.Sig,
	}, &ack, 5*time.Second)
	return ack, err
}

// Result types for socket-based auth (mirror the old HTTP contract).

type SaltResult struct {
	Salt   string
	Banned bool
}

type VerifyResult struct {
	Allow bool
	Known bool
}

type PolicyResult struct {
	Unreachable        bool // control plane not answering — link error, NOT a verdict
	PublishKey         bool
	RequireAccountAuth bool
	WindowOpen         bool
	Banned             bool
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = cryptoRead(b)
	return hexEncode(b)
}

func cryptoRead(b []byte) (int, error) { return rand.Read(b) }
func hexEncode(b []byte) string         { return hex.EncodeToString(b) }
