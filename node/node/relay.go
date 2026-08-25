// Relay helpers shared by BOTH control transports (the socket.io Client and
// the protobuf-WebSocket WsClient): WHEP SDP forwarding to the colocated SRS
// and recording-file streaming out of this node's records dir.
package node

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// whepRelayHTTP forwards a browser's WHEP offer to this node's colocated SRS.
// Returns (answer, "") on 201, ("", error) otherwise. The SRS API port is
// deliberately never published — this relay is the only path.
//
// The stream name MUST go into the query with a LITERAL '@': SRS does not
// URL-decode the WHEP query, and stream names are emails — an escaped %40
// makes the subscriber resolve a DIFFERENT (empty) RTC source than the one
// the RTMP publisher feeds, and playback shows "connected, 0 bytes" forever
// (verified against SRS 6.0.191 on 2026-08-25: literal @ reuses the
// publisher's source, %40 spawns a fresh empty one).
func whepRelayHTTP(whepBase, streamName string, offer []byte) (string, string) {
	if whepBase == "" {
		return "", "node has no SRS API base configured"
	}
	q := url.Values{}
	q.Set("app", "live")
	q.Set("stream", streamName)
	target := strings.TrimRight(whepBase, "/") + "/rtc/v1/whep/?" + strings.ReplaceAll(q.Encode(), "%40", "@")
	resp, err := http.Post(target, "application/sdp", bytes.NewReader(offer))
	if err != nil {
		return "", "srs unreachable: " + err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 {
		return "", fmt.Sprintf("srs whep responded %d: %.200s", resp.StatusCode, string(body))
	}
	return string(body), ""
}

// resolveWithinRecordDir validates a RELATIVE path and returns the absolute
// path under root — recording rel paths come from the control plane (DB
// rows), so they are untrusted input.
func resolveWithinRecordDir(root, rel string) (string, error) {
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") || filepath.Base(clean) == "" {
		return "", fmt.Errorf("invalid path")
	}
	abs := filepath.Join(root, clean)
	if !strings.HasPrefix(abs, filepath.Clean(root)+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes records dir")
	}
	return abs, nil
}

// relayFile streams one file in chunks until EOF, cancellation, or the 2GiB
// cap. sendChunk carries the raw bytes on whichever transport invoked this
// (base64 JSON frames on socket.io, protobuf bytes on the WS transport); a
// send error ends the transfer as success-by-partial (the receiver's stall
// watchdog owns failure reporting).
func relayFile(recordDir, relPath string, sendChunk func([]byte) error, canceled func() bool) error {
	abs, err := resolveWithinRecordDir(recordDir, relPath)
	if err != nil {
		return err
	}
	f, err := os.Open(abs)
	if err != nil {
		return fmt.Errorf("open %s: %w", relPath, err)
	}
	st, _ := f.Stat()
	log.Printf("[rec] streaming %s (%d bytes)", relPath, st.Size())
	defer f.Close()

	buf := make([]byte, 256*1024)
	total := 0
	for total < 2*1024*1024*1024 {
		n, err := f.Read(buf)
		if n > 0 {
			total += n
			if e := sendChunk(buf[:n]); e != nil {
				log.Printf("[rec] chunk send failed after %d bytes: %v", total, e)
				return nil
			}
		}
		if err != nil {
			if canceled() {
				return nil // stopped by the app — normal teardown
			}
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read: %w", err)
		}
	}
	return nil
}
