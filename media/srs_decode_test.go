package media

import (
	"encoding/json"
	"testing"
)

// Captured verbatim from the live NAS SRS (2026-08-20): kbps is an OBJECT,
// video/audio null right after publish start. The old struct failed to decode
// this ENTIRE payload (int ← object) → GetStreamInfo nil → no metrics ever.
const livePayloadEarly = `{"code":0,"server":"vid-pyk6w54","streams":[
{"id":"vid-a1446l8","name":"123123@nottingham.edu.cn","vhost":"vid-ve07er2","app":"live",
"live_ms":1787194232074,"clients":1,"frames":0,"send_bytes":4210,"recv_bytes":3346,
"kbps":{"recv_30s":0,"send_30s":0},"publish":{"active":true,"cid":"yrv265o8"},
"video":null,"audio":null}]}`

const livePayloadSteady = `{"code":0,"streams":[
{"name":"123123@nottingham.edu.cn","live_ms":1,"clients":1,"frames":900,
"send_bytes":9,"recv_bytes":9,"kbps":{"recv_30s":2450,"send_30s":2400},
"publish":{"active":true,"cid":"z"},
"video":{"codec":"H264","profile":"Main","level":"3.1","width":1920,"height":1080,"fps":29.97},
"audio":{"codec":"AAC","sample_rate":44100,"channel":2,"profile":"LC"}}]}`

func TestSRSStreamInfoDecodesLivePayloads(t *testing.T) {
	var early struct {
		Streams []SRSStreamInfo `json:"streams"`
	}
	if err := json.Unmarshal([]byte(livePayloadEarly), &early); err != nil {
		t.Fatalf("EARLY payload must decode (old struct failed here): %v", err)
	}
	s := early.Streams[0]
	if s.Name != "123123@nottingham.edu.cn" {
		t.Fatalf("name: %q", s.Name)
	}
	if s.Video != nil || s.Audio != nil {
		t.Fatal("video/audio should be nil early in the stream")
	}
	if s.TotalBitrateKbps() != 0 {
		t.Fatalf("early bitrate: %d", s.TotalBitrateKbps())
	}
	if !s.Publish.Active || s.Publish.Cid != "yrv265o8" {
		t.Fatalf("publish block: %+v", s.Publish)
	}

	var steady struct {
		Streams []SRSStreamInfo `json:"streams"`
	}
	if err := json.Unmarshal([]byte(livePayloadSteady), &steady); err != nil {
		t.Fatal(err)
	}
	v := steady.Streams[0]
	if v.Video == nil || v.Video.Width != 1920 || v.Video.Height != 1080 || v.Video.Fps != 29.97 {
		t.Fatalf("video: %+v", v.Video)
	}
	if v.TotalBitrateKbps() != 2450 {
		t.Fatalf("bitrate (recv_30s): %d", v.TotalBitrateKbps())
	}
}
