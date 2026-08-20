// SRS REST API client: stream info (dimensions/fps/bitrate for compliance),
// client kill, and health check. No ffmpeg/ffprobe — everything comes from
// SRS's own HTTP API which reports live stream metadata.
package media

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// SRSClient manages the colocated SRS via its REST API.
type SRSClient struct {
	base string
	hc   *http.Client
}

// NewSRSClient creates a client against the SRS API base URL.
func NewSRSClient(apiBase string) *SRSClient {
	return &SRSClient{
		base: apiBase,
		hc:   &http.Client{Timeout: 5 * time.Second},
	}
}

// SRSStreamInfo mirrors SRS /api/v1/streams response fields we need.
// VERIFIED against a live response: `kbps` is an OBJECT {recv_30s,send_30s}
// (NOT a number — decoding it as an int fails the WHOLE payload, so metrics
// never reach the dashboard), and `video`/`audio` are null until the first
// frames arrive — hence the pointers.
type SRSStreamInfo struct {
	Name      string `json:"name"`
	LiveMs    int64  `json:"liveMs"`
	Clients   int    `json:"clients"`
	Frames    int    `json:"frames"`
	SendBytes int64  `json:"sendBytes"`
	Kbps      struct {
		Recv30s int `json:"recv_30s"` // what SRS receives FROM the publisher
		Send30s int `json:"send_30s"`
	} `json:"kbps"`
	Publish struct {
		Active bool   `json:"active"`
		Cid    string `json:"cid"` // SRS client id of the publisher
	} `json:"publish"`
	Video *struct {
		Codec   string  `json:"codec"`
		Profile string  `json:"profile"`
		Level   string  `json:"level"`
		Width   int     `json:"width"`
		Height  int     `json:"height"`
		Fps     float64 `json:"fps"`
	} `json:"video"`
	Audio *struct {
		Codec      string `json:"codec"`
		SampleRate int    `json:"sample_rate"`
		Channel    int    `json:"channel"`
		Profile    string `json:"profile"`
	} `json:"audio"`
}

// BitrateKbps is the publish-side bitrate (what SRS receives from OBS).
func (i *SRSStreamInfo) BitrateKbps() int { return i.Kbps.Recv30s }

// GetStreamInfo fetches metrics for one live stream by name.
// Returns nil if not found or on error.
func (c *SRSClient) GetStreamInfo(streamName string) *SRSStreamInfo {
	u := c.base + "/streams?count=200"
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil
	}
	resp, err := c.hc.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return nil
	}
	defer resp.Body.Close()

	var data struct {
		Streams []SRSStreamInfo `json:"streams"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil
	}

	// Find our stream (SRS URL-encodes names with @)
	decoded, _ := url.QueryUnescape(streamName)
	for i := range data.Streams {
		name, _ := url.QueryUnescape(data.Streams[i].Name)
		if name == streamName || name == decoded || data.Streams[i].Name == streamName {
			return &data.Streams[i]
		}
	}
	return nil
}

// KillClient force-disconnects a publisher by SRS client ID.
func (c *SRSClient) KillClient(clientID string) bool {
	if clientID == "" {
		return false
	}
	u := c.base + "/clients/" + url.PathEscape(clientID)
	req, err := http.NewRequest(http.MethodDelete, u, nil)
	if err != nil {
		return false
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		fmt.Printf("[srs] killClient %s error: %v\n", clientID, err)
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ListLiveStreamNames returns the names of currently-live streams (decoded).
// Returns nil on error.
func (c *SRSClient) ListLiveStreamNames() map[string]bool {
	u := c.base + "/streams?count=200"
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil
	}
	resp, err := c.hc.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return nil
	}
	defer resp.Body.Close()

	var data struct {
		Streams []struct {
			Name string `json:"name"`
		} `json:"streams"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil
	}

	names := make(map[string]bool, len(data.Streams))
	for _, s := range data.Streams {
		decoded, err := url.QueryUnescape(s.Name)
		if err != nil {
			decoded = s.Name
		}
		names[decoded] = true
	}
	return names
}

// HealthCheck pings the SRS API.
func (c *SRSClient) HealthCheck() bool {
	u := c.base + "/versions"
	resp, err := c.hc.Get(u)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusOK
}
