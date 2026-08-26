// Upstream = the gateway as an RTMP *publisher* client to SRS. After OBS is
// authenticated, the gateway opens this connection, runs connect → createStream
// → publish (replaying OBS' stream name verbatim so SRS' on_publish hook +
// authorizePublish do event auth unchanged), then forwards every audio/video/
// script frame OBS sends. A background drain goroutine reads+discards SRS' own
// messages so SRS' send buffer can't fill and block our writes.
package rtmp

import (
	"fmt"
	"log"
	"net"
)

type Upstream struct {
	Conn     net.Conn
	Cw       *chunkWriter
	Cr       *chunkReader
	StreamID float64
}

// DialUpstream connects to SRS, handshakes, sets chunk size, connect()s and
// createStream()s. The publish happens later (once we know OBS' stream name).
// `app` is the RTMP application to publish under: the event key (slug), so
// SRS DVRs straight into /records/<app>/<stream>/ — the records layout is
// decided at publish time and the node never creates directories.
func DialUpstream(addr, app string) (*Upstream, error) {
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
	tcURL := "rtmp://" + addr + "/" + app
	if err := up.Cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdConnect(app, tcURL)}); err != nil {
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

// publish sends publish(streamName,"live") and waits for onStatus. SRS
// answering with an ERROR (unsupported codec, bad name, …) used to be treated
// as success because only "a command arrived" was checked — the gateway then
// told OBS "Publish.Start" and streamed into a dead relay. Now the verdict is
// parsed: error → fail the publish so the caller rejects the client outright.
func (up *Upstream) Publish(name string) error {
	if err := up.Cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdPublish(name)}); err != nil {
		return err
	}
	vals, err := up.readUntilCommand()
	if err != nil {
		return err
	}
	if code, desc := onStatusVerdict(vals); code != "" && code != "NetStream.Publish.Start" {
		return fmt.Errorf("upstream rejected publish: %s (%s)", code, desc)
	}
	return nil
}

// onStatusVerdict extracts (code, description) from an onStatus/onResult
// command: vals = [name, txn?, info-map]; the info map carries
// code/description. Returns "" when the shape isn't an onStatus info object.
func onStatusVerdict(vals []interface{}) (string, string) {
	for _, v := range vals {
		m, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		code, _ := m["code"].(string)
		if code == "" {
			continue
		}
		desc, _ := m["description"].(string)
		return code, desc
	}
	return "", ""
}

// writeFrame forwards a media/script message to SRS on the upstream stream id.
func (up *Upstream) WriteFrame(m *Message) error {
	fwd := *m
	fwd.StreamID = uint32(up.StreamID)
	return up.Cw.WriteMessage(&fwd)
}

// drain reads SRS→gateway messages (onStatus, ACKs, control) so SRS' send
// side never blocks. Two things must ESCAPE the drain loop instead of being
// discarded:
//   - a mid-stream onStatus ERROR from SRS (fatal for the relay)
//   - the upstream connection dying (read error)
//
// Both call onDeath — the server closes the OBS connection with BadName so
// the publisher sees an immediate, terminal rejection instead of streaming
// into a dead pipe for minutes. Run in its own goroutine after publish.
func (up *Upstream) Drain(remote string, onDeath func(reason string)) {
	for {
		msg, err := up.Cr.ReadMessage()
		if err != nil {
			log.Printf("%s upstream closed: %v", remote, err)
			onDeath("upstream connection lost: " + err.Error())
			return
		}
		if msg.Type == 20 || msg.Type == 17 { // AMF0 / AMF3 command
			if code, desc := onStatusVerdict(AmfDecodeAll(msg.Payload)); code != "" && code != "NetStream.Publish.Start" {
				log.Printf("%s upstream onStatus %s: %s", remote, code, desc)
				onDeath("upstream: " + code + " — " + desc)
				return
			}
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
