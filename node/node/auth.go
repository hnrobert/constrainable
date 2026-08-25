// Auth result types shared by the RTMP handshake (rtmp/server.go consumes
// these via the AppClient interface) and the WS control client's authmod
// RPCs (wsclient.go). The socket.io-era client methods that lived here are
// gone with the transport.
package node

import (
	"crypto/rand"
	"encoding/hex"
)

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
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
