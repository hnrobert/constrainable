// capture.go — diagnostic mode (CAPTURE=1): a silent RTMP server that completes
// the handshake, accepts OBS' connect WITHOUT issuing any authmod challenge, and
// dumps the full AMF0 connect object. Purpose: settle whether OBS puts the
// "Use authentication" username/password inside the connect command on its own
// (in which case the gateway could read creds at connect and decide per-event at
// publish), or only ever sends them under a server challenge (the authmod dance).
//
// Every handshake/message stage is logged with a read deadline, so a stall
// reports exactly WHERE it hung (C0 / C1 / C2 / connect) instead of hanging
// silently — this also validates our hand-rolled handshake against real OBS.
//
// Run:  CAPTURE=1 RTMP_LISTEN=:11935 go run ./rtmp-gateway
// Then in OBS: Server rtmp://localhost:11935/live, Stream key anything,
// Use authentication ON, Username/Password set, Start Streaming.
package rtmp

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"time"
)

func runCapture(listen string) {
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("capture listen %s: %v", listen, err)
	}
	log.Printf("CAPTURE MODE on %s — point OBS here with 'Use authentication' ON and Start Streaming.", listen)
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go handleCapture(conn)
	}
}

// handleCapture handshakes (logged), sends NO challenge, and logs every AMF
// command OBS sends (connect, createStream, publish, …) with each value's type.
func handleCapture(conn net.Conn) {
	remote := conn.RemoteAddr().String()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("%s capture panic: %v", remote, r)
		}
		_ = conn.Close()
	}()
	log.Printf("=== capture: connection from %s ===", remote)

	if err := captureHandshake(conn, remote); err != nil {
		log.Printf("%s HANDSHAKE FAILED: %v", remote, err)
		return
	}

	cw := NewChunkWriter(conn)
	cr := NewChunkReader(conn)
	_ = cw.WriteMessage(&Message{Type: 1, CSID: 2, Payload: PutBE4(4096)}) // our chunk size

	for n := 0; n < 24; n++ {
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		msg, err := cr.ReadMessage()
		if err != nil {
			log.Printf("%s message read ended: %v", remote, err)
			return
		}
		// Apply OBS' chunk size — WITHOUT this, a connect command longer than
		// our 128-byte default gets misframed into garbage (OBS announces a large
		// chunk size right after the handshake; the reader must honor it).
		if msg.Type == 1 {
			cr.chunkSize = int(BE32(msg.Payload))
			log.Printf("    (SetChunkSize → %d)", cr.chunkSize)
			continue
		}
		// Log any other non-command message type, so "OBS is sending protocol
		// traffic but no connect" is distinguishable from total silence.
		if msg.Type != 20 && msg.Type != 17 {
			log.Printf("    (msg type=%d csid=%d len=%d — not a command, skipped)", msg.Type, msg.CSID, len(msg.Payload))
			continue
		}
		vals := AmfDecodeAll(msg.Payload)
		if len(vals) == 0 {
			continue
		}
		cmd, _ := vals[0].(string)
		txn := 0.0
		if len(vals) >= 2 {
			txn, _ = vals[1].(float64)
		}
		log.Printf(">>> '%s' (AMF0=%v) txn=%v — %d values:", cmd, msg.Type == 20, txn, len(vals))
		for j, v := range vals {
			log.Printf("      [%d] (%T) %s", j, v, dumpAMF(v))
		}
		if cmd == "connect" {
			// Acknowledge connect minimally so OBS proceeds to publish (NO challenge).
			_ = cw.WriteMessage(&Message{Type: 5, CSID: 2, Payload: PutBE4(2500000)})               // window ack size
			_ = cw.WriteMessage(&Message{Type: 6, CSID: 2, Payload: append(PutBE4(2500000), 0x02)}) // peer bandwidth (dynamic)
			_ = cw.WriteMessage(&Message{Type: 4, CSID: 2, Payload: []byte{0, 0, 0, 0, 0, 0}})      // StreamBegin msid 0
			_ = cw.WriteMessage(&Message{Type: 20, CSID: 3, Payload: CmdConnectOK(txn)})
			log.Printf("    (sent Connect.Success with NO challenge — watching what OBS does next)")
		}
		if cmd == "publish" {
			log.Printf("%s >>> publish seen — capture complete", remote)
			return
		}
	}
}

// captureHandshake mirrors serverHandshake but logs each stage and uses read
// deadlines, so a stall names the exact read that hung.
func captureHandshake(c net.Conn, remote string) error {
	_ = c.SetReadDeadline(time.Now().Add(8 * time.Second))

	c0, err := ReadN(c, 1)
	if err != nil {
		return fmt.Errorf("read C0 (OBS sent nothing?): %w", err)
	}
	log.Printf("%s hs: C0 version byte = %d", remote, c0[0])
	if c0[0] != 0x03 {
		return fmt.Errorf("C0 version %d != 3", c0[0])
	}

	c1, err := ReadN(c, 1536)
	if err != nil {
		return fmt.Errorf("read C1: %w", err)
	}
	log.Printf("%s hs: C1 ok — client time=%d, first16=% x", remote, BE32(c1[0:4]), c1[:16])

	s1 := make([]byte, 1536)
	copy(s1[4:8], c1[0:4])
	resp := append(append([]byte{0x03}, s1...), c1...) // S0 || S1 || S2(=C1 echo)
	if _, err := c.Write(resp); err != nil {
		return fmt.Errorf("write S0+S1+S2: %w", err)
	}
	log.Printf("%s hs: sent S0+S1+S2 (%d bytes)", remote, len(resp))

	c2, err := ReadN(c, 1536)
	if err != nil {
		return fmt.Errorf("read C2 — OBS did not echo back (likely rejected our S0S1S2): %w", err)
	}
	log.Printf("%s hs: C2 ok (%d bytes) — handshake complete", remote, len(c2))
	_ = c.SetReadDeadline(time.Time{})
	return nil
}

// dumpAMF renders an AMF0 value readably (JSON for objects/maps; %#v fallback).
func dumpAMF(v interface{}) string {
	if v == nil {
		return "null"
	}
	b, err := json.MarshalIndent(v, "", "    ")
	if err != nil {
		return fmt.Sprintf("%#v", v)
	}
	return string(b)
}
