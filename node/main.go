// media-node entry point: renders the SRS config, starts SRS as a child
// process, waits for it, then starts the RTMP ingest server and the protobuf
// WebSocket connection to the Node control plane. The SRS config template is
// embedded in the image — each container is fully self-contained.
package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"media-node/media"
	"media-node/node"
	"media-node/rtmp"
)

const version = "0.7.0"

// startSRS renders the config template and starts SRS. The RENDER always
// happens: when SRS runs as a sidecar container (SRS_BIN empty), the rendered
// file lives on a volume shared with that container, which waits for it to
// appear before starting — this node stays the single owner of SRS config.
// With SRS_BIN set, SRS is started here as a child process instead.
// Returns the cmd (nil in sidecar mode) so the caller can forward signals.
func startSRS(cfg *Config) *exec.Cmd {
	// Render the config template (${SRS_RTC_CANDIDATE}, ${SRS_HTTP_PORT})
	tpl, err := os.ReadFile(cfg.SRSConfigTpl)
	if err != nil {
		log.Fatalf("[srs] read template %s: %v", cfg.SRSConfigTpl, err)
	}
	conf := string(tpl)
	conf = strings.ReplaceAll(conf, "${SRS_RTC_CANDIDATE}", cfg.SRSRTCCandidate)
	conf = strings.ReplaceAll(conf, "${SRS_HTTP_PORT}", strconv.Itoa(cfg.SRSHTTPPort))
	conf = strings.ReplaceAll(conf, "${SRS_UDP_PORT}", strconv.Itoa(cfg.SRSUDPPort))
	if err := os.WriteFile(cfg.SRSConfigPath, []byte(conf), 0644); err != nil {
		log.Fatalf("[srs] write config %s: %v", cfg.SRSConfigPath, err)
	}
	log.Printf("[srs] rendered config %s (candidate=%s, http-port=%d)", cfg.SRSConfigPath, cfg.SRSRTCCandidate, cfg.SRSHTTPPort)

	var cmd *exec.Cmd
	if cfg.SRSBin == "" {
		log.Printf("[srs] SRS_BIN not set — SRS runs as a sidecar container; waiting for its API")
	} else {
		cmd = exec.Command(cfg.SRSBin, "-c", cfg.SRSConfigPath)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Fatalf("[srs] start %s: %v", cfg.SRSBin, err)
		}
		log.Printf("[srs] started pid=%d", cmd.Process.Pid)
	}

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

// sweepCleanTwinJunk removes leftover watch-twin DVR directories under
// live/. The app's watch transcoding twins (services/cleanstream.ts) push
// re-encoded copies under SRS app "live" with the stream name prefixed
// "clean-" (the prefix is the app-side contract — same one the teardown
// sentinel relies on). Their DVR output is junk by design: the app wipes it
// on twin teardown, but SRS's DVR finalize (.tmp → .flv rename) can land
// AFTER those sentinels and re-create the directory (verified live, >15s
// lag), and a crash or app restart mid-watch strands it too. Real
// recordings never use the prefix: event publishes land under app
// <eventKey>, anonymous ones under live/<stream> with their own name.
// Run at boot AND on a ticker — unambiguous junk, so deleting even while a
// twin is actively writing is fine (its finalize-rename then just misses).
// No deployment ever needs manual records cleanup.
func sweepCleanTwinJunk(recordDir string) {
	entries, err := os.ReadDir(filepath.Join(recordDir, "live"))
	if err != nil {
		return // no live/ bucket — nothing to sweep
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "clean-") {
			if err := os.RemoveAll(filepath.Join(recordDir, "live", e.Name())); err == nil {
				n++
			}
		}
	}
	if n > 0 {
		log.Printf("[dvr] swept %d leftover clean-twin junk dir(s) under live/", n)
	}
}

// reportRecording scans RECORD_DIR/<eventKey>/<stream>/ for the FLV segments
// SRS DVR wrote during the session and reports them to the control plane
// (recording:ready). The relay publishes under app=<eventKey> and the SRS
// dvr_path template is /records/[app]/[stream]/ — files land in their FINAL
// layout at publish time; this function only scans and reports (NO move, no
// directory creation — the node stays read-only on the records tree).
// The directory is SHARED by every session of that stream (the final layout
// is also its archive), so only files WRITTEN during THIS session count:
// mtime >= session start (small grace for clock jitter). Without the window,
// a republish would re-report yesterday's segments — the app would append
// duplicates, and files whose recording row was deleted in between would
// come back as phantoms that 500 every later playback.
// Runs in its own goroutine with a short delay — SRS finalizes (closes) the
// DVR file only after it sees the relay go away.
// Delivery is RETRIED for up to 15 minutes: a single emit can be lost to an
// app restart mid-roll (production incident 2026-08: files on disk, no DB
// rows), so keep re-reporting until it lands.
func reportRecording(cfg *Config, c node.ControlClient, s *media.Session) {
	go func() {
		time.Sleep(2 * time.Second)

		// Same app derivation as the relay's SRS publish (rtmp/server.go):
		// the event key, else the plain "live" bucket. There is NO e<eventId>
		// middle step on the publish side, so there must be none here either —
		// a mismatch would scan a directory SRS never wrote to.
		eventDir := s.EventKey
		if eventDir == "" {
			eventDir = "live"
		}
		dir := filepath.Join(cfg.RecordDir, eventDir, s.StreamName)
		entries, err := os.ReadDir(dir)
		if err != nil {
			// PERMISSION failures land here too and used to exit SILENTLY —
			// the 2026-08-26 incident: files on disk, no [dvr] log, no DB
			// rows, nothing.
			log.Printf("[dvr] scan %s failed: %v", dir, err)
			return
		}
		// Session window: SRS creates (and keeps touching) this session's DVR
		// file only after the relay starts pushing, i.e. after s.StartedAt.
		since := s.StartedAt.Add(-2 * time.Second)
		var segs []node.RecordingSegment
		var total int64
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".flv") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.ModTime().Before(since) {
				continue // a previous session's segment — already reported then
			}
			segs = append(segs, node.RecordingSegment{
				RelPath:   path.Join(eventDir, s.StreamName, e.Name()),
				SizeBytes: info.Size(),
			})
			total += info.Size()
		}
		if len(segs) == 0 {
			return
		}
		dur := int(time.Since(s.StartedAt).Seconds())
		deadline := time.Now().Add(15 * time.Minute)
		for {
			rep := node.RecordingReady{
				NodeID:      c.NodeID(),
				StreamName:  s.StreamName,
				EventID:     s.EventID,
				SessionID:   s.SessionID,
				Segments:    segs,
				SizeBytes:   total,
				DurationSec: dur,
				AvgFps:      s.Fps,
				Width:       s.Width,
				Height:      s.Height,
			}
			if err := c.Emit("recording:ready", rep); err == nil {
				log.Printf("[dvr] reported %d segment(s) for %s (%d bytes)", len(segs), s.StreamName, total)
				return
			}
			if time.Now().After(deadline) {
				log.Printf("[dvr] reporting %s FAILED after 15min — %d segment(s) stay on disk for manual recovery",
					s.StreamName, len(segs))
				return
			}
			time.Sleep(10 * time.Second)
		}
	}()
}

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	log.Printf("media-node v%s | api=%s | id=%s | hostname=%s",
		version, cfg.APIOrigin, cfg.NodeIdentifier, cfg.Hostname)
	srsHost := cfg.SRSAddr
	if i := strings.LastIndex(srsHost, ":"); i >= 0 {
		srsHost = srsHost[:i]
	}
	srsHTTPBase := fmt.Sprintf("http://%s:%d", srsHost, cfg.SRSHTTPPort)
	log.Printf("rtmp :%d | srs-udp :%d | srs=%s | srs-http=%s | srs-api=%s | flv-base=%s",
		cfg.RTMPPort, cfg.SRSUDPPort, cfg.SRSAddr, srsHTTPBase, cfg.SRSApiBase, cfg.SRSFlvBase)

	// Start colocated SRS (renders config template → starts → waits for API)
	srsCmd := startSRS(cfg)

	// SRS client (stream info, killClient, health)
	srsClient := media.NewSRSClient(cfg.SRSApiBase)

	// Browser-side latency probe: STUN responder on its own UDP port (see
	// node/probe.go). Failure is non-fatal — the rest of the node works; the
	// control plane just reports the node as probe-less.
	go func() {
		if err := node.ServeProbe(fmt.Sprintf(":%d", cfg.ProbeUDPPort), cfg.AuthToken); err != nil {
			log.Printf("[probe] STUN responder failed: %v", err)
		}
	}()

	// Control-plane client: the protobuf WebSocket (the only transport since
	// v0.6.0 — socket.io was retired when the Bun app's node:http upgrade
	// path broke).
	registerPayload := node.RegisterPayload{
		Identifier:         cfg.NodeIdentifier,
		PublicOrigin:       cfg.PublicOrigin,
		PublicRTMPPort:     cfg.PublicRTMPPort,
		PublicProbeUDPPort: cfg.PublicProbeUDPPort,
		PublicSrsUDPPort:   cfg.PublicSrsUDPPort,
		RTMPPort:           cfg.RTMPPort,
		SRSFlvBase:         cfg.SRSFlvBase,
		Hostname:           cfg.Hostname,
		Version:            version,
	}
	wsClient := node.NewWsClient(cfg.APIOrigin, cfg.ControlWsOrigin, cfg.AuthToken, registerPayload)
	wsClient.SRSWhepBase = strings.TrimSuffix(cfg.SRSApiBase, "/api/v1")
	wsClient.RecordDir = cfg.RecordDir
	var socketClient node.ControlClient = wsClient
	log.Printf("[node] control transport: protobuf websocket (%s/ws/media-node)", cfg.ControlWsOrigin)

	// Session manager
	manager := media.NewManager(
		srsClient,
		func(sessionID int64, s *media.Session) {
			_ = socketClient.Emit("publish:metrics", node.MetricsReport{
				SessionID: sessionID, Width: s.Width, Height: s.Height,
				Fps: s.Fps, VideoBitrateKbps: s.VideoBitrateKbps, AudioBitrateKbps: s.DeclaredAudioBitrateKbps(),
			})
		},
		func(sessionID int64, reasons []string, s *media.Session) {
			_ = socketClient.Emit("violation", node.ViolationReport{
				SessionID: sessionID, Reasons: reasons,
				Metrics: &node.MetricsReport{
					SessionID: sessionID, Width: s.Width, Height: s.Height,
					Fps: s.Fps, VideoBitrateKbps: s.VideoBitrateKbps, AudioBitrateKbps: s.DeclaredAudioBitrateKbps(),
				},
			})
		},
		func(sessionID int64, endedAt int64, durationSec int, s *media.Session) {
			_ = socketClient.Emit("publish:end", node.EndReport{
				SessionID: sessionID, EndedAt: endedAt, DurationSec: durationSec,
			})
			reportRecording(cfg, socketClient, s)
		},
	)

	// RTMP session hooks: the gate asks the control plane to open the session
	// (publish:start ack carries the session row, limits and record flag) once
	// the upstream relay is up; OnUnpublish ends tracking (which reports
	// publish:end + the DVR recording).
	rtmp.OnPublishGate = func(streamName, token, authedUser string) rtmp.PublishGrant {
		var auth node.PublishAuthorized
		err := socketClient.EmitWithAck("publish:start", node.PublishStart{
			NodeID:      socketClient.NodeID(),
			StreamName:  streamName,
			Token:       token,
			AuthedUser:  authedUser,
			SRSClientID: "",
		}, &auth, 5*time.Second)
		if err != nil {
			log.Printf("[node] publish:start %s: %v (fail-closed)", streamName, err)
			return rtmp.PublishGrant{}
		}
		if !auth.Allow {
			log.Printf("[node] publish:start %s denied: %s", streamName, auth.Reason)
			return rtmp.PublishGrant{}
		}
		var limits *rtmp.GateLimits
		if auth.Limits != nil {
			limits = &rtmp.GateLimits{
				MaxWidth:            auth.Limits.MaxWidth,
				MaxHeight:           auth.Limits.MaxHeight,
				MaxFps:              auth.Limits.MaxFps,
				MaxVideoBitrateKbps: auth.Limits.MaxVideoBitrateKbps,
				MaxAudioBitrateKbps: auth.Limits.MaxAudioBitrateKbps,
			}
		}
		// measured enforcement only when the event opted in — the caps go to
		// the monitor solely for that; the declared gate uses them whenever
		// Strict (checked locally in the RTMP handler, metadata-time).
		monitorLimits := auth.Limits
		if !auth.Measured {
			monitorLimits = nil
		}
		manager.Start(streamName, auth.SessionID, auth.EventID, auth.EventKey, "", monitorLimits, auth.Record)
		return rtmp.PublishGrant{Allowed: true, Limits: limits, Strict: auth.Strict, Measured: auth.Measured, EventKey: auth.EventKey}
	}
	rtmp.OnUnpublish = func(streamName string) {
		manager.End(streamName)
	}
	rtmp.OnPublishSpec = func(streamName string, spec rtmp.StreamSpec, limits *rtmp.GateLimits, strict bool) (bool, string) {
		// Record the declared audio rate so the measured monitor can report
		// and judge the VIDEO bitrate (OBS' "Video Bitrate" field semantics).
		manager.SetDeclaredAudioBitrateKbps(streamName, int(spec.AudioBitrateKbps))
		// Declared geometry/framerate: the recording report and the measured
		// monitor's fallback (see Manager.SetDeclaredSpec).
		manager.SetDeclaredSpec(streamName, spec.Width, spec.Height, spec.Fps)
		// Ask the control plane for a verdict on this declared spec (fresh every
		// time — the event's caps/strict may have changed). Transport failure
		// falls back to the publish grant's caps.
		verdict, err := socketClient.VerifySpec(node.PublishSpec{
			NodeID:           socketClient.NodeID(),
			StreamName:       streamName,
			Width:            spec.Width,
			Height:           spec.Height,
			Fps:              spec.Fps,
			VideoKbps:        spec.VideoKbps,
			AudioBitrateKbps: spec.AudioBitrateKbps,
		})
		if err != nil {
			log.Printf("[spec] %s: verify transport error (%v) — falling back to grant caps", streamName, err)
			if strict && limits != nil {
				if reasons := rtmp.SpecViolations(spec, limits); len(reasons) > 0 {
					return false, "Stream rejected: " + strings.Join(reasons, "; ") + ". Lower your OBS resolution/FPS/bitrate to the event's limits and reconnect."
				}
			}
			return true, ""
		}
		if !verdict.Allow {
			return false, verdict.Reason
		}
		log.Printf("[spec] %s declared %dx%d@%.2f video=%.0fkbps audio=%.0fkbps — verified",
			streamName, spec.Width, spec.Height, spec.Fps, spec.VideoKbps, spec.AudioBitrateKbps)
		return true, ""
	}

	socketClient.SetOnKick(func(kick node.NodeKick) {
		log.Printf("[node] kick: %s", kick.StreamName)
		// Closing the relay runs the normal unpublish path (session end +
		// recording report); if the stream is already gone this is a no-op.
		rtmp.KillStream(kick.StreamName)
	})
	socketClient.SetOnConfig(func(c node.ConfigLimits) {
		log.Printf("[node] config:limits received")
	})
	// WHEP relay routing: subscribers must select the same SRS app the relay
	// publishes under (app=<eventKey> since v0.7.0; clean- twins → "live").
	node.SetSrsAppLookup(manager.EventKeyOf)

	socketClient.SetOnDelete(func(del node.RecordingDelete) error {
		log.Printf("[node] recording:delete %d path(s)", len(del.Segments))
		for _, seg := range del.Segments {
			clean := filepath.Clean(seg)
			if strings.Contains(clean, "..") || filepath.IsAbs(clean) {
				continue // untrusted input — never escape RECORD_DIR
			}
			abs := filepath.Join(cfg.RecordDir, clean)
			if !strings.HasPrefix(abs, filepath.Clean(cfg.RecordDir)+string(os.PathSeparator)) {
				continue
			}
			if filepath.Ext(abs) == "" {
				// no-extension sentinel = wipe a whole directory (the clean
				// twin's watch-only DVR output; see app cleanstream.ts)
				_ = os.RemoveAll(abs)
			} else {
				_ = os.Remove(abs)
			}
		}
		return nil
	})

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

	sweepCleanTwinJunk(cfg.RecordDir)
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			sweepCleanTwinJunk(cfg.RecordDir)
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
