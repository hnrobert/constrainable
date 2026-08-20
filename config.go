// Package main: media-node — a distributed Go backend that fronts RTMP ingest
// and reports to the Node control plane via Socket.IO. Recording is handled by
// SRS's native DVR; metrics come from SRS's HTTP API. Zero external deps.
package main

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// Config holds every tunable for one media-node instance.
type Config struct {
	// Control plane (constrainable-app)
	APIOrigin      string // e.g. http://constrainable-app:31954 — for socket.io
	AuthToken      string // shared secret with Node (socket auth)
	NodeIdentifier string // stable unique identity (drives nodeId: user
	// assignments, session ownership, quotas). NOT an address.
	PublicOrigin       string // PUBLIC_MEDIA_NODE_ORIGIN — public hostname/IP of this node ("" = users push via the app's host)
	PublicRTMPPort     int    // PUBLIC_MEDIA_NODE_RTMP_PORT — publicly mapped RTMP ingest port
	PublicProbeUDPPort int    // PUBLIC_MEDIA_NODE_PROBE_UDP_PORT — publicly mapped STUN probe responder port
	PublicSrsUDPPort   int    // PUBLIC_MEDIA_NODE_SRS_UDP_PORT — publicly mapped SRS WebRTC UDP (media) port
	Hostname           string // human-readable name

	// Listeners
	RTMPPort     int // RTMP ingest (OBS pushes here)
	ProbeUDPPort int // STUN responder for browser latency probes (UDP)
	SRSUDPPort   int // SRS rtc_server UDP listen — browsers' WebRTC media port
	// (must equal the published host port: the SDP candidate carries it)
	SRTPort int // SRT ingest (scaffold; not yet implemented)

	// SRS (sidecar container named `srs` on the deployment network; or a
	// child process when SRS_BIN is set — then use localhost:1935/1985)
	SRSAddr     string // RTMP relay target (host:port)
	SRSApiBase  string // HTTP API for stream info / killClient / health
	SRSHTTPPort int    // SRS http_server port (FLV remux) — rendered into the
	// config AND used for the advertised FLV base default
	SRSFlvBase string // HTTP-FLV base ADVERTISED to the control plane (how the
	// app backend pulls playback). Docker deployments point
	// this at the service name; browsers never see it.
	SRSBin          string // path to the SRS binary (empty = don't start SRS)
	SRSConfigPath   string // path to the rendered SRS config
	SRSConfigTpl    string // path to the config template (embedded in image)
	SRSRTCCandidate string // WebRTC ICE candidate advertised to browsers.
	// Empty + PUBLIC_NODE_ORIGIN set ⇒ derived from its host
	// (browsers must reach this directly over UDP).

	// Recording (SRS DVR writes FLV; Go only needs the dir for file cleanup)
	RecordDir string

	// Behavior
	AllowDirectSRS bool
}

// LoadConfig reads environment variables.
func LoadConfig() (*Config, error) {
	c := &Config{
		APIOrigin:          envOr("API_ORIGIN", "http://localhost:31954"),
		AuthToken:          os.Getenv("MEDIA_NODE_AUTH_TOKEN"),
		NodeIdentifier:     envOr("NODE_IDENTIFIER", "media-node"),
		PublicOrigin:       envOr("PUBLIC_MEDIA_NODE_ORIGIN", ""),
		PublicRTMPPort:     envOrInt("PUBLIC_MEDIA_NODE_RTMP_PORT", 1935),
		PublicProbeUDPPort: envOrInt("PUBLIC_MEDIA_NODE_PROBE_UDP_PORT", envOrInt("PROBE_UDP_PORT", 38111)),
		PublicSrsUDPPort:   envOrInt("PUBLIC_MEDIA_NODE_SRS_UDP_PORT", envOrInt("SRS_UDP_PORT", 38000)),
		RTMPPort:           envOrInt("RTMP_PORT", 1935),
		ProbeUDPPort:       envOrInt("PROBE_UDP_PORT", 38111), // browser ICE latency probe (STUN responder)
		SRSUDPPort:         envOrInt("SRS_UDP_PORT", 38000),
		SRSAddr:            envOr("SRS_ADDR", "srs:1935"),                   // docker sidecar service name
		SRSApiBase:         envOr("SRS_API_BASE", "http://srs:1985/api/v1"), // docker sidecar service name
		SRSHTTPPort:        envOrInt("SRS_HTTP_PORT", 38081),                // internal-only (never published); 38080 is the node's own play port
		SRSFlvBase:         envOr("SRS_FLV_BASE", ""),                       // empty = derived from SELF_ORIGIN below
		SRSBin:             envOr("SRS_BIN", ""),                            // empty = SRS runs elsewhere
		SRSConfigTpl:       envOr("SRS_CONFIG_TEMPLATE", "/etc/media-node/srs.conf.template"),
		SRSConfigPath:      envOr("SRS_CONFIG_PATH", "/tmp/srs.conf"),
		SRSRTCCandidate:    envOr("SRS_RTC_CANDIDATE", ""),
		RecordDir:          envOr("RECORD_DIR", "./records"),
		AllowDirectSRS:     os.Getenv("ALLOW_DIRECT_SRS") == "true",
	}

	if h, err := os.Hostname(); err == nil && h != "" {
		c.Hostname = envOr("HOSTNAME_OVERRIDE", h)
	} else {
		c.Hostname = envOr("HOSTNAME_OVERRIDE", "media-node")
	}

	c.APIOrigin = strings.TrimRight(c.APIOrigin, "/")
	c.SRSApiBase = strings.TrimRight(c.SRSApiBase, "/")

	// Public origin is a BARE HOST (a full URL is tolerated and reduced).
	if c.PublicOrigin != "" {
		c.PublicOrigin = originHost(c.PublicOrigin)
	}

	// WebRTC candidate: browsers connect DIRECTLY over UDP to this host.
	// Derive from the public origin (same machine as SRS); loopback when
	// nothing public is configured (single-server default).
	if c.SRSRTCCandidate == "" {
		if c.PublicOrigin != "" {
			c.SRSRTCCandidate = originHost(c.PublicOrigin)
		} else {
			c.SRSRTCCandidate = "127.0.0.1" // single-server default
		}
	}

	// Advertised FLV base defaults to the identifier's host + the SRS
	// http_server port. Override with SRS_FLV_BASE when the control plane
	// reaches this node differently than the public internet does (e.g. a
	// shared Docker network: http://srs:38081).
	if c.SRSFlvBase == "" {
		host := strings.TrimPrefix(strings.TrimPrefix(c.NodeIdentifier, "https://"), "http://")
		host = strings.Split(host, "/")[0]
		host = strings.Split(host, ":")[0]
		c.SRSFlvBase = fmt.Sprintf("http://%s:%d", host, c.SRSHTTPPort)
	}
	c.SRSFlvBase = strings.TrimRight(c.SRSFlvBase, "/")

	// Empty token = no auth (Node accepts unauthenticated media nodes)
	if c.AuthToken == "" {
		log.Printf("[config] MEDIA_NODE_AUTH_TOKEN is empty — connecting without auth")
	}

	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envOrInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		n := 0
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// originHost strips scheme, path and port from an origin URL, leaving the host.
func originHost(origin string) string {
	host := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	if i := strings.IndexAny(host, "/:"); i >= 0 {
		host = host[:i]
	}
	return host
}
