// Package node: STUN responder for browser-side LATENCY PROBES.
//
// Browsers can only speak UDP via WebRTC, and SRS's rtc port answers STUN
// solely for sessions it negotiated itself (verified experimentally — a
// binding request with a live session's real credentials is still dropped),
// so nodes expose this dedicated UDP port instead. The browser runs an ICE
// check against it (the control plane mints the matching answer SDP — see
// constrainable-app's /api/nodes/probe-ice), and the candidate-pair stats
// give the true browser→node RTT.
//
// The ICE password is DERIVED, identically on both sides, from the shared
// node auth token: base64(hmac-sha256(token, "ice-probe"))[:22] — the browser
// must validate the response's MESSAGE-INTEGRITY against the answer SDP's
// pwd, so responder and SDP-minter need the same value without a new secret.
package node

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"log"
	"net"
)

// probeUfrag is the fixed ICE username fragment of the responder.
const probeUfrag = "probe"

// ProbeIcePwd derives the ICE password shared with the control plane. Must
// stay byte-identical to the app-side derivation (services/node-probe.ts).
func ProbeIcePwd(authToken string) string {
	mac := hmac.New(sha256.New, []byte(authToken))
	mac.Write([]byte("ice-probe"))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))[:22]
}

const (
	stunMagicCookie = 0x2112A442
	stunBindingReq  = 0x0001
	stunBindingOK   = 0x0101
	stunMI          = 0x0008
	stunFingerprint = 0x8028
	stunXorMapped   = 0x0020
	stunFPCrcXor    = 0x5354554e
)

// ServeProbe answers ICE binding requests on addr (":38111") forever. State-
// less: one datagram in, one binding-success out (XOR-MAPPED-ADDRESS + MI +
// FINGERPRINT). Non-binding or malformed datagrams are dropped silently.
func ServeProbe(addr, authToken string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	defer pc.Close()
	log.Printf("[probe] STUN responder listening on %s (ufrag=%s)", addr, probeUfrag)

	pwd := ProbeIcePwd(authToken)
	buf := make([]byte, 1500)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return err
		}
		udp, ok := from.(*net.UDPAddr)
		if !ok || n < 20 || binary.BigEndian.Uint32(buf[4:8]) != stunMagicCookie {
			continue
		}
		if binary.BigEndian.Uint16(buf[0:2]) != stunBindingReq {
			continue
		}
		resp, ok := bindingSuccess(buf[:n], udp, pwd)
		if !ok {
			continue
		}
		_, _ = pc.WriteTo(resp, from)
	}
}

// bindingSuccess builds the response for a request: header (echoed txid) +
// XOR-MAPPED-ADDRESS, then MESSAGE-INTEGRITY, then FINGERPRINT. MI is
// HMAC-SHA1 computed with the header length INCLUDING the MI attribute, per
// RFC 5389 §15.4.
func bindingSuccess(req []byte, from *net.UDPAddr, pwd string) ([]byte, bool) {
	ip4 := from.IP.To4()
	if ip4 == nil {
		return nil, false // IPv6 probe source — not supported
	}
	// XOR-MAPPED-ADDRESS: family(0x01), xport ^ (cookie>>16), addr ^ cookie
	xma := make([]byte, 8)
	xma[1] = 0x01
	binary.BigEndian.PutUint16(xma[2:4], uint16(from.Port)^uint16(stunMagicCookie>>16))
	binary.BigEndian.PutUint32(xma[4:8], binary.BigEndian.Uint32(ip4)^stunMagicCookie)

	out := make([]byte, 20)
	binary.BigEndian.PutUint16(out[0:2], stunBindingOK)
	binary.BigEndian.PutUint32(out[4:8], stunMagicCookie)
	copy(out[8:20], req[8:20]) // echo transaction id

	out = appendAttr(out, stunXorMapped, xma)
	out = withMI(out, pwd)
	out = withFingerprint(out)
	return out, true
}

// appendAttr appends a padded TLV and sets the header length to cover it.
func appendAttr(msg []byte, t uint16, v []byte) []byte {
	head := []byte{byte(t >> 8), byte(t), byte(len(v) >> 8), byte(len(v))}
	msg = append(append(msg, head...), v...)
	for len(msg)%4 != 0 {
		msg = append(msg, 0)
	}
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(msg)-20))
	return msg
}

// withMI appends MESSAGE-INTEGRITY (HMAC-SHA1, 20 bytes). The MAC is taken
// with the length field set to include the upcoming MI attribute — which
// equals the final post-append length, so appendAttr's update is consistent.
func withMI(msg []byte, pwd string) []byte {
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(msg)-20+24))
	mac := hmac.New(sha1.New, []byte(pwd))
	mac.Write(msg)
	return appendAttr(msg, stunMI, mac.Sum(nil))
}

// withFingerprint appends FINGERPRINT: CRC32(IEEE) over the message (length
// including the FP attribute) XORed with 0x5354554e.
func withFingerprint(msg []byte) []byte {
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(msg)-20+8))
	v := make([]byte, 4)
	binary.BigEndian.PutUint32(v, crc32.ChecksumIEEE(msg)^stunFPCrcXor)
	return appendAttr(msg, stunFingerprint, v)
}
