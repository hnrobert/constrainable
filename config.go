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
	PublicDomain string // browser-reachable DOMAIN ("" in single-server
	// deployments where users reach everything via the app's host;
	// multi-node deployments MUST set it)
	PublicPlayPort int // public port of the play entry (0 = same as PlayPort)
	PublicRtmpPort int // PUBLIC port of the RTMP ingest (OBS-facing; 1935
	// standard — only differs when the tunnel remaps it)
	PublicOrigin string // CONSTRUCTED: http://PUBLIC_DOMAIN:PUBLIC_PLAY_PORT
	Hostname     string // human-readable name

	// Listeners
	RTMPPort int // RTMP ingest (OBS pushes here)
	PlayPort int // HTTP-FLV playback entry (browsers pull directly; each pull
	// is authorized by the control plane over the socket)
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
	SRSRTCCandidate string // WebRTC ICE candidate (rendered into config)

	// Recording (SRS DVR writes FLV; Go only needs the dir for file cleanup)
	RecordDir string

	// Behavior
	AllowDirectSRS bool
}

// LoadConfig reads environment variables.
func LoadConfig() (*Config, error) {
	c := &Config{
		APIOrigin:       envOr("API_ORIGIN", "http://localhost:31954"),
		AuthToken:       os.Getenv("MEDIA_NODE_AUTH_TOKEN"),
		NodeIdentifier:  envOr("NODE_IDENTIFIER", "media-node"),
		PublicDomain:    strings.TrimRight(envOr("PUBLIC_DOMAIN", ""), "/"),
		PublicPlayPort:  envOrInt("PUBLIC_PLAY_PORT", 0),
		PublicRtmpPort:  envOrInt("PUBLIC_RTMP_PORT", 1935),
		RTMPPort:        envOrInt("RTMP_PORT", 1935),
		PlayPort:        envOrInt("PLAY_PORT", 38080),
		SRTPort:         envOrInt("SRT_PORT", 9000),
		SRSAddr:         envOr("SRS_ADDR", "srs:1935"),                   // docker sidecar service name
		SRSApiBase:      envOr("SRS_API_BASE", "http://srs:1985/api/v1"), // docker sidecar service name
		SRSHTTPPort:     envOrInt("SRS_HTTP_PORT", 38081),                // internal-only (never published); 38080 is the node's own play port
		SRSFlvBase:      envOr("SRS_FLV_BASE", ""),                       // empty = derived from SELF_ORIGIN below
		SRSBin:          envOr("SRS_BIN", ""),                            // empty = SRS runs elsewhere
		SRSConfigTpl:    envOr("SRS_CONFIG_TEMPLATE", "/etc/media-node/srs.conf.template"),
		SRSConfigPath:   envOr("SRS_CONFIG_PATH", "/tmp/srs.conf"),
		SRSRTCCandidate: envOr("SRS_RTC_CANDIDATE", "127.0.0.1"),
		RecordDir:       envOr("RECORD_DIR", "./records"),
		AllowDirectSRS:  os.Getenv("ALLOW_DIRECT_SRS") == "true",
	}

	if h, err := os.Hostname(); err == nil && h != "" {
		c.Hostname = envOr("HOSTNAME_OVERRIDE", h)
	} else {
		c.Hostname = envOr("HOSTNAME_OVERRIDE", "media-node")
	}

	c.APIOrigin = strings.TrimRight(c.APIOrigin, "/")
	c.SRSApiBase = strings.TrimRight(c.SRSApiBase, "/")

	// Public base = domain + public play port (drives latency probing, the
	// OBS ingest host for assigned users, and direct-playback signed URLs).
	// Empty when no PUBLIC_DOMAIN is configured.
	if c.PublicDomain != "" {
		port := c.PublicPlayPort
		if port == 0 {
			port = c.PlayPort
		}
		c.PublicOrigin = fmt.Sprintf("http://%s:%d", c.PublicDomain, port)
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
