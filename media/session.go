// Session: tracks one active publish stream on this node. Recording is handled
// entirely by SRS's native DVR module (writes FLV directly from the RTMP stream,
// zero external process). This file only tracks session state + monitors via
// periodic SRS API queries (no ffprobe — SRS API reports stream dimensions).
package media

import (
	"log"
	"math"
	"sync"
	"time"

	"media-node/node"
)

// Session tracks one live publisher's state.
type Session struct {
	SessionID   int64
	EventID     *int64
	StreamName  string
	SRSClientID string
	Record      bool
	StartedAt   time.Time

	mu          sync.Mutex
	active      bool
	compliant   bool
	Width       int
	Height      int
	Fps         float64
	BitrateKbps int

	// declared audio bitrate from onMetaData, clamped to [0,320]. Bitrate
	// limits mean the OBS "Video Bitrate" field, so the MEASURED value is
	// estimated as total-received minus this — SRS reports no per-track
	// split. The clamp keeps a forged huge declaration from zeroing the
	// video estimate (measured mode is the anti-forgery layer).
	declaredAudioKbps int

	// deltas for derived metrics: the SRS API reports NO fps, and kbps is a
	// 30s rolling average (0 right after start) — both are computed from the
	// cumulative counters between consecutive polls
	lastFrames    int64
	lastRecvBytes int64
	lastPollAt    time.Time
}

// Manager owns all active sessions on this node.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	srs      *SRSClient

	// callbacks
	reportMetrics   func(sessionID int64, s *Session)
	reportViolation func(sessionID int64, reasons []string, s *Session)
	reportEnd       func(sessionID int64, endedAt int64, durationSec int, s *Session)
}

// NewManager creates a session manager that monitors via SRS API.
func NewManager(
	srs *SRSClient,
	onMetrics func(int64, *Session),
	onViolation func(int64, []string, *Session),
	onEnd func(int64, int64, int, *Session),
) *Manager {
	return &Manager{
		sessions:        make(map[string]*Session),
		srs:             srs,
		reportMetrics:   onMetrics,
		reportViolation: onViolation,
		reportEnd:       onEnd,
	}
}

// Start begins tracking a session. Spawns a monitor that polls SRS API for
// stream metrics (dimensions/fps/bitrate) — no ffprobe needed.
func (m *Manager) Start(
	streamName string,
	sessionID int64,
	eventID *int64,
	srsClientID string,
	limits *node.Limits,
	record bool,
) {
	m.mu.Lock()
	if _, exists := m.sessions[streamName]; exists {
		m.mu.Unlock()
		return
	}
	s := &Session{
		SessionID:   sessionID,
		EventID:     eventID,
		StreamName:  streamName,
		SRSClientID: srsClientID,
		Record:      record,
		StartedAt:   time.Now(),
		active:      true,
	}
	m.sessions[streamName] = s
	m.mu.Unlock()

	// Monitor: poll SRS API for metrics every 5s
	go m.monitor(s, limits)
	log.Printf("[session] started %s (session=%d record=%v)", streamName, sessionID, record)
}

// SetDeclaredAudioKbps records the publisher's DECLARED audio bitrate
// (onMetaData audiodatarate) so the monitor can subtract it from the
// received total — the reported/judged bitrate is the VIDEO bitrate, the
// number OBS' "Video Bitrate" field shows. Clamped to [0,320]: audio above
// 320 kbps is not a real thing, and a forged larger value would otherwise
// hide video from the measured check.
func (m *Manager) SetDeclaredAudioKbps(streamName string, audioKbps int) {
	m.mu.Lock()
	s, ok := m.sessions[streamName]
	m.mu.Unlock()
	if !ok {
		return
	}
	if audioKbps < 0 {
		audioKbps = 0
	}
	if audioKbps > 320 {
		audioKbps = 320
	}
	s.mu.Lock()
	s.declaredAudioKbps = audioKbps
	s.mu.Unlock()
}

// Lookup returns a live session's control-plane identity. Nil pointers/zero
// values with ok=false mean the session isn't active.
func (m *Manager) Lookup(streamName string) (sessionID int64, eventID *int64, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, found := m.sessions[streamName]
	if !found {
		return 0, nil, false
	}
	return s.SessionID, s.EventID, true
}

// End stops tracking and reports final metrics + duration.
// Recording finalization is handled by SRS DVR (on_unpublish closes the file).
func (m *Manager) End(streamName string) {
	m.mu.Lock()
	s, ok := m.sessions[streamName]
	if !ok {
		m.mu.Unlock()
		return
	}
	delete(m.sessions, streamName)
	m.mu.Unlock()

	s.mu.Lock()
	s.active = false
	s.mu.Unlock()

	endedAt := time.Now()
	durationSec := int(endedAt.Sub(s.StartedAt).Seconds())

	if m.reportEnd != nil {
		m.reportEnd(s.SessionID, endedAt.UnixMilli(), durationSec, s)
	}
	log.Printf("[session] ended %s (session=%d duration=%ds)", streamName, s.SessionID, durationSec)
}

// ActiveStreams returns the count of live sessions.
func (m *Manager) ActiveStreams() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// monitor polls SRS API for stream metrics and checks limits.
func (m *Manager) monitor(s *Session, limits *node.Limits) {
	time.Sleep(3 * time.Second) // wait for stream to stabilize

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		s.mu.Lock()
		active := s.active
		s.mu.Unlock()
		if !active {
			return
		}

		// Query SRS API for this stream's metrics
		info := m.srs.GetStreamInfo(s.StreamName)
		if info == nil {
			continue // stream not found (SRS API hiccup)
		}

		s.mu.Lock()
		if info.Video != nil {
			s.Width = info.Video.Width
			s.Height = info.Video.Height
		}
		// fps/bitrate from counter deltas (Frames / RecvBytes are cumulative).
		// Bitrate is the VIDEO estimate: total received minus the declared
		// audio — limits and the dashboard mean OBS' "Video Bitrate" field.
		now := time.Now()
		if !s.lastPollAt.IsZero() {
			dt := now.Sub(s.lastPollAt).Seconds()
			if dt > 0.1 {
				if fps := float64(int64(info.Frames)-s.lastFrames) / dt; fps > 0 {
					s.Fps = math.Round(fps*100) / 100
				}
				if kbps := float64(info.RecvBytes-s.lastRecvBytes) * 8 / dt / 1000; kbps > 0 {
					video := int(math.Round(kbps)) - s.declaredAudioKbps
					if video < 0 {
						video = 0
					}
					s.BitrateKbps = video
				}
			}
		}
		s.lastFrames, s.lastRecvBytes, s.lastPollAt = int64(info.Frames), info.RecvBytes, now
		s.mu.Unlock()

		// Report metrics
		if m.reportMetrics != nil {
			m.reportMetrics(s.SessionID, s)
		}

		// Check limits
		if limits != nil {
			reasons := checkLimits(s, limits)
			if len(reasons) > 0 {
				if m.reportViolation != nil {
					m.reportViolation(s.SessionID, reasons, s)
				}
			} else if !s.compliant {
				s.mu.Lock()
				s.compliant = true
				s.mu.Unlock()
			}
		}
	}
}

// checkLimits returns violation reasons.
func checkLimits(s *Session, l *node.Limits) []string {
	var reasons []string
	if l.MaxWidth > 0 && s.Width > l.MaxWidth {
		reasons = append(reasons, "resolution exceeds limit")
	}
	if l.MaxHeight > 0 && s.Height > l.MaxHeight {
		if len(reasons) == 0 {
			reasons = append(reasons, "resolution exceeds limit")
		}
	}
	if l.MaxFps > 0 && s.Fps > float64(l.MaxFps) {
		reasons = append(reasons, "fps exceeds limit")
	}
	// 10% headroom on the measured video estimate: RTMP chunking overhead
	// and encoder ABR overshoot ride on top of the nominal rate — without
	// it, a stream set exactly AT the cap would flag on every poll.
	if l.MaxVideoBitrateKbps > 0 && s.BitrateKbps > l.MaxVideoBitrateKbps+l.MaxVideoBitrateKbps/10 {
		reasons = append(reasons, "bitrate exceeds limit")
	}
	// Audio cap: measured audio isn't separable from the total cheaply, so
	// police the DECLARED rate (what the user set in OBS) — same 10% headroom.
	if l.MaxAudioBitrateKbps > 0 && s.declaredAudioKbps > l.MaxAudioBitrateKbps+l.MaxAudioBitrateKbps/10 {
		reasons = append(reasons, "audio bitrate exceeds limit")
	}
	return reasons
}
