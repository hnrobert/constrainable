// WebSocket dial shared by both control transports: we own the TCP conn,
// bound the ENTIRE handshake with a deadline (websocket.Dial would block
// forever on a server that accepts TCP but never speaks), then hand it to
// websocket.NewClient and clear the deadline so read loops can apply their
// own per-read bounds.
package node

import (
	"crypto/tls"
	"net"
	"net/url"
	"time"

	"golang.org/x/net/websocket"
)

// dialWebsocket connects to wsURL with `origin` as the WS Origin header.
func dialWebsocket(origin, wsURL string) (*websocket.Conn, error) {
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

	cfg, err := websocket.NewConfig(wsURL, origin)
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
