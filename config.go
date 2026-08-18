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
	// Node control plane
	NodeOrigin string // e.g. http://node:31954 — for socket.io
	AuthToken  string // shared secret with Node (socket auth)
	SelfOrigin string // e.g. ingest-1 — this node's public identifier
	Hostname   string // human-readable name

	// Listeners
	RTMPPort int // RTMP ingest (OBS pushes here) — the ONLY listener
	SRTPort  int // SRT ingest (scaffold; not yet implemented)

	// SRS (colocated child process, managed by this binary)
	SRSAddr        string // RTMP relay target (host:port)
	SRSApiBase     string // HTTP API for stream info / killClient / health
	SRSBin         string // path to the SRS binary (empty = don't start SRS)
	SRSConfigPath  string // path to the rendered SRS config
	SRSConfigTpl   string // path to the config template (embedded in image)
	SRSRTCCandidate string // WebRTC ICE candidate (rendered into config)

	// Recording (SRS DVR writes FLV; Go only needs the dir for file cleanup)
	RecordDir string

	// Behavior
	AllowDirectSRS bool
}

// LoadConfig reads environment variables.
func LoadConfig() (*Config, error) {
	c := &Config{
		NodeOrigin:     envOr("NODE_ORIGIN", "http://localhost:31954"),
		AuthToken:      os.Getenv("MEDIA_NODE_AUTH_TOKEN"),
		SelfOrigin:     envOr("SELF_ORIGIN", "localhost"),
		RTMPPort:       envOrInt("RTMP_PORT", 1935),
		SRTPort:        envOrInt("SRT_PORT", 9000),
		SRSAddr:        envOr("SRS_ADDR", "localhost:1935"),
		SRSApiBase:     envOr("SRS_API_BASE", "http://localhost:1985/api/v1"),
		SRSBin:         envOr("SRS_BIN", ""), // empty = SRS runs elsewhere
		SRSConfigTpl:   envOr("SRS_CONFIG_TEMPLATE", "/etc/media-node/srs.conf.template"),
		SRSConfigPath:  envOr("SRS_CONFIG_PATH", "/tmp/srs.conf"),
		SRSRTCCandidate: envOr("SRS_RTC_CANDIDATE", "127.0.0.1"),
		RecordDir:      envOr("RECORD_DIR", "./records"),
		AllowDirectSRS: os.Getenv("ALLOW_DIRECT_SRS") == "true",
	}

	if h, err := os.Hostname(); err == nil && h != "" {
		c.Hostname = envOr("HOSTNAME_OVERRIDE", h)
	} else {
		c.Hostname = envOr("HOSTNAME_OVERRIDE", "media-node")
	}

	c.NodeOrigin = strings.TrimRight(c.NodeOrigin, "/")
	c.SRSApiBase = strings.TrimRight(c.SRSApiBase, "/")

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
