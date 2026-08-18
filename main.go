// media-node entry point: renders the SRS config, starts SRS as a child
// process, waits for it, then starts the RTMP ingest server and the Socket.IO
// connection to the Node control plane. The SRS config template is embedded
// in the image — each container is fully self-contained.
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"media-node/media"
	"media-node/node"
	"media-node/rtmp"
)

const version = "0.4.0"

// startSRS renders the config template and starts SRS as a child process.
// Returns the cmd so the caller can forward signals. If cfg.SRSBin is empty
// (SRS runs as a separate container), this is a no-op.
func startSRS(cfg *Config) *exec.Cmd {
	if cfg.SRSBin == "" {
		log.Printf("[srs] SRS_BIN not set — assuming SRS runs elsewhere")
		return nil
	}

	// Render the config template (substitute ${SRS_RTC_CANDIDATE})
	tpl, err := os.ReadFile(cfg.SRSConfigTpl)
	if err != nil {
		log.Fatalf("[srs] read template %s: %v", cfg.SRSConfigTpl, err)
	}
	conf := strings.ReplaceAll(string(tpl), "${SRS_RTC_CANDIDATE}", cfg.SRSRTCCandidate)
	if err := os.WriteFile(cfg.SRSConfigPath, []byte(conf), 0644); err != nil {
		log.Fatalf("[srs] write config %s: %v", cfg.SRSConfigPath, err)
	}
	log.Printf("[srs] rendered config %s (candidate=%s)", cfg.SRSConfigPath, cfg.SRSRTCCandidate)

	// Start SRS
	cmd := exec.Command(cfg.SRSBin, "-c", cfg.SRSConfigPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatalf("[srs] start %s: %v", cfg.SRSBin, err)
	}
	log.Printf("[srs] started pid=%d", cmd.Process.Pid)

	// Wait for SRS API to be reachable (max 15s)
	srsClient := media.NewSRSClient(cfg.SRSApiBase)
	for i := 0; i < 30; i++ {
		if srsClient.HealthCheck() {
			log.Printf("[srs] API is up")
			return cmd
		}
		time.Sleep(500 * time.Millisecond)
	}
	log.Printf("[srs] WARNING: API not reachable after 15s, continuing anyway")
	return cmd
}

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	log.Printf("media-node v%s | node=%s | self=%s | hostname=%s",
		version, cfg.NodeOrigin, cfg.SelfOrigin, cfg.Hostname)
	log.Printf("rtmp :%d | srs=%s | srs-api=%s",
		cfg.RTMPPort, cfg.SRSAddr, cfg.SRSApiBase)

	// Start colocated SRS (renders config template → starts → waits for API)
	srsCmd := startSRS(cfg)

	// SRS client (stream info, killClient, health)
	srsClient := media.NewSRSClient(cfg.SRSApiBase)

	// Socket.IO client — ALL communication with the Node control plane
	socketClient := node.NewClient(cfg.NodeOrigin, cfg.AuthToken, node.RegisterPayload{
		Origin:   cfg.SelfOrigin,
		RTMPPort: cfg.RTMPPort,
		SRTPort:  cfg.SRTPort,
		Hostname: cfg.Hostname,
		Version:  version,
	})

	// Session manager
	manager := media.NewManager(
		srsClient,
		func(sessionID int64, s *media.Session) {
			_ = socketClient.Emit("publish:metrics", node.MetricsReport{
				SessionID: sessionID, Width: s.Width, Height: s.Height,
				Fps: s.Fps, BitrateKbps: s.BitrateKbps,
			})
		},
		func(sessionID int64, reasons []string, s *media.Session) {
			_ = socketClient.Emit("violation", node.ViolationReport{
				SessionID: sessionID, Reasons: reasons,
				Metrics: &node.MetricsReport{
					SessionID: sessionID, Width: s.Width, Height: s.Height,
					Fps: s.Fps, BitrateKbps: s.BitrateKbps,
				},
			})
		},
		func(sessionID int64, endedAt int64, durationSec int, s *media.Session) {
			_ = socketClient.Emit("publish:end", node.EndReport{
				SessionID: sessionID, EndedAt: endedAt, DurationSec: durationSec,
			})
		},
	)

	socketClient.OnKick = func(kick node.NodeKick) {
		log.Printf("[node] kick: %s", kick.StreamName)
		manager.End(kick.StreamName)
	}
	socketClient.OnConfig = func(c node.ConfigLimits) {
		log.Printf("[node] config:limits received")
	}
	socketClient.OnDelete = func(del node.RecordingDelete) error {
		log.Printf("[node] recording:delete %d", del.RecordingID)
		for _, seg := range del.Segments {
			_ = os.Remove(fmt.Sprintf("%s/%s", cfg.RecordDir, seg))
		}
		return nil
	}

	go socketClient.Run()

	// SRS watchdog (exits for container restart if SRS stays down >30s)
	go func() {
		failCount := 0
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if !srsClient.HealthCheck() {
				failCount++
				if failCount >= 3 {
					log.Fatalf("[watchdog] SRS down >30s")
				}
			} else {
				failCount = 0
			}
		}
	}()

	// RTMP ingest
	rtmpLn, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.RTMPPort))
	if err != nil {
		log.Fatalf("rtmp listen :%d: %v", cfg.RTMPPort, err)
	}
	rtmp.SRSAddr = cfg.SRSAddr
	log.Printf("rtmp server listening on :%d", cfg.RTMPPort)

	go func() {
		for {
			conn, err := rtmpLn.Accept()
			if err != nil {
				log.Printf("rtmp accept: %v", err)
				continue
			}
			go func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("conn %s panic: %v", conn.RemoteAddr(), r)
					}
					_ = conn.Close()
				}()
				rtmp.HandleOBS(conn, socketClient)
			}()
		}
	}()

	log.Printf("media-node ready (active streams: %d)", manager.ActiveStreams())

	// graceful shutdown: stop media-node, then SRS
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down...")
	socketClient.Close()
	_ = rtmpLn.Close()
	if srsCmd != nil && srsCmd.Process != nil {
		_ = srsCmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { _ = srsCmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = srsCmd.Process.Kill()
		}
	}
}
