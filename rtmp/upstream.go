// Upstream = the gateway as an RTMP *publisher* client to SRS. After OBS is
// authenticated, the gateway opens this connection, runs connect → createStream
// → publish (replaying OBS' stream name verbatim so SRS' on_publish hook +
// authorizePublish do event auth unchanged), then forwards every audio/video/
// script frame OBS sends. A background drain goroutine reads+discards SRS' own
// messages so SRS' send buffer can't fill and block our writes.
package rtmp

import (
	"log"
	"net"
)

type Upstream struct {
	Conn     net.Conn
	Cw       *chunkWriter
	Cr       *chunkReader
	StreamID float64
}

// dialUpstream connects to SRS, handshakes, sets chunk size, connect()s and
// createStream()s. The publish happens later (once we know OBS' stream name).
func DialUpstream(addr string) (*Upstream, error) {
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	if err := ClientHandshake(conn); err != nil {
		conn.Close()
		return nil, err
	}
	up := &Upstream{Conn: conn, Cw: NewChunkWriter(conn), Cr: NewChunkReader(conn)}

	// Announce our chunk size, then connect.
	if err := up.Cw.WriteMessage(&Message{Type: 1, CSID: 2, Payload: PutBE4(4096)}); err != nil {
		up.Close()
		return nil, err
	}
	tcURL := "rtmp://" + addr + "/live"
	if err := up.Cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdConnect("live", tcURL)}); err != nil {
		up.Close()
		return nil, err
	}
	if _, err := up.readUntilCommand(); err != nil { // connect _result
		up.Close()
		return nil, err
	}
	if err := up.Cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdCreateStream()}); err != nil {
		up.Close()
		return nil, err
	}
	vals, err := up.readUntilCommand() // createStream _result
	if err != nil {
		up.Close()
		return nil, err
	}
	if len(vals) >= 4 {
		if sid, ok := vals[3].(float64); ok {
			up.StreamID = sid
		}
	}
	if up.StreamID == 0 {
		up.StreamID = 1
	}
	return up, nil
}

// publish sends publish(streamName,"live") and waits for the first command back
// (typically onStatus NetStream.Publish.Start).
func (up *Upstream) Publish(name string) error {
	if err := up.Cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdPublish(name)}); err != nil {
		return err
	}
	if _, err := up.readUntilCommand(); err != nil {
		return err
	}
	return nil
}

// writeFrame forwards a media/script message to SRS on the upstream stream id.
func (up *Upstream) WriteFrame(m *Message) error {
	fwd := *m
	fwd.StreamID = uint32(up.StreamID)
	return up.Cw.WriteMessage(&fwd)
}

// drain reads and discards SRS→gateway messages (onStatus, ACKs, control) so
// SRS' send side never blocks. Run in its own goroutine after publish.
func (up *Upstream) Drain(remote string) {
	for {
		if _, err := up.Cr.ReadMessage(); err != nil {
			log.Printf("%s upstream closed: %v", remote, err)
			return
		}
	}
}

func (up *Upstream) Close() { _ = up.Conn.Close() }

// readUntilCommand skips control/set-chunk-size messages until an AMF command
// arrives, then returns its decoded values.
func (up *Upstream) readUntilCommand() ([]interface{}, error) {
	for {
		msg, err := up.Cr.ReadMessage()
		if err != nil {
			return nil, err
		}
		switch msg.Type {
		case 1: // SetChunkSize
			up.Cr.chunkSize = int(BE32(msg.Payload))
		case 20, 17: // AMF0 / AMF3 command
			return AmfDecodeAll(msg.Payload), nil
		}
	}
}
