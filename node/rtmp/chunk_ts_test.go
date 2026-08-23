package rtmp

// fmt-3 chunks opening NEW messages must advance ts by the last delta (spec),
// not 0 — the regression made SRS reject relayed streams ("Queue input is
// backward in time"). Frames: video keyframe 40000B split across chunkSize,
// then two fmt-3-opened audio messages.

import (
	"bytes"
	"testing"
)

func TestFmt3NewMessageAdvancesTimestamp(t *testing.T) {
	var buf bytes.Buffer
	cw := &chunkWriter{w: &buf, chunkSize: 128}

	// fmt-0 message, ts=1000, 200B payload → fmt-0 + fmt-3 continuation(s)
	_ = cw.WriteMessage(&Message{Type: 9, CSID: 4, StreamID: 1, Timestamp: 1000, Payload: bytes.Repeat([]byte{1}, 200)})
	// two more messages written as fmt-3 by the writer itself; observed on the
	// reader side they must carry advancing timestamps 2000, 3000 (delta 1000)
	_ = cw.WriteMessage(&Message{Type: 9, CSID: 4, StreamID: 1, Timestamp: 2000, Payload: bytes.Repeat([]byte{2}, 50)})
	_ = cw.WriteMessage(&Message{Type: 9, CSID: 4, StreamID: 1, Timestamp: 3000, Payload: bytes.Repeat([]byte{3}, 50)})

	// read back with a reader whose chunkSize matches the writer
	rd := &bytes.Reader{}
	_ = rd
	cr := NewChunkReader(bytes.NewReader(buf.Bytes()))
	cr.chunkSize = 128
	var got []uint32
	for i := 0; i < 3; i++ {
		m, err := cr.ReadMessage()
		if err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		got = append(got, m.Timestamp)
	}
	if got[0] != 1000 || got[1] != 2000 || got[2] != 3000 {
		t.Fatalf("timestamps regressed/frozen: got %v, want [1000 2000 3000]", got)
	}
}
