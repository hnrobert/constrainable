// Direct playback entry: browsers pull HTTP-FLV from THIS node (:PLAY_PORT)
// so video bandwidth never transits the control plane. Every pull is
// authorized first — the node relays the browser's signed-URL query to the
// control plane over Socket.IO (play:auth ack) and proxies the FLV from the
// SRS sidecar only on an explicit allow. Fail-closed: no ack, no stream.
package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"media-node/node"
)

// PlayServer is the public FLV entry (auth gate + reverse proxy to SRS).
type PlayServer struct {
	auth   func(p node.PlayAuth) (node.PlayAuthAck, error)
	proxy  *httputil.ReverseProxy
	client *node.Client
}

// NewPlayServer builds the playback server. srsHTTPBase is where the SRS
// sidecar serves HTTP-FLV (e.g. http://srs:38081), reached over the internal
// network — never by browsers.
func NewPlayServer(client *node.Client, srsHTTPBase string) *PlayServer {
	target, err := url.Parse(strings.TrimRight(srsHTTPBase, "/"))
	if err != nil {
		log.Fatalf("[play] bad SRS http base %q: %v", srsHTTPBase, err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	// live streaming: flush every chunk immediately, no buffering
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[play] upstream %s: %v", r.URL.Path, err)
		w.WriteHeader(http.StatusBadGateway)
	}
	return &PlayServer{
		auth:   func(p node.PlayAuth) (node.PlayAuthAck, error) { return client.PlayAuth(p) },
		proxy:  proxy,
		client: client,
	}
}

// Handler serves /live/<stream>.flv?exp=&sig= — everything else 404s.
func (s *PlayServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/live/", s.serveFLV)
	return mux
}

func (s *PlayServer) serveFLV(w http.ResponseWriter, r *http.Request) {
	// browsers hit this cross-origin (app domain → node domain): mpegts'
	// fetch loader does a simple GET, so a wildcard allow-origin suffices
	// (no credentials are or should be sent here)
	w.Header().Set("Access-Control-Allow-Origin", "*")

	name := strings.TrimPrefix(r.URL.Path, "/live/")
	name = strings.TrimSuffix(name, ".flv")
	if name == "" || strings.Contains(name, "/") {
		http.NotFound(w, r)
		return
	}

	var exp int64
	fmt.Sscanf(r.URL.Query().Get("exp"), "%d", &exp)
	sig := r.URL.Query().Get("sig")

	ack, err := s.auth(node.PlayAuth{Stream: name, Exp: exp, Sig: sig})
	if err != nil || !ack.Allow {
		if err != nil {
			log.Printf("[play] auth error for %s: %v (fail-closed)", name, err)
		} else {
			log.Printf("[play] denied %s: %s", name, ack.Reason)
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("playback not authorized"))
		return
	}
	log.Printf("[play] serving %s -> %s", name, r.RemoteAddr)
	s.proxy.ServeHTTP(w, r)
}

// startPlayServer runs the playback entry until the process ends.
func startPlayServer(addr string, srv *PlayServer) *http.Server {
	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[play] listen %s: %v", addr, err)
		}
	}()
	log.Printf("[play] direct FLV entry listening on %s (auth via control plane)", addr)
	return httpSrv
}
