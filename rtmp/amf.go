// AMF0 codec — the subset RTMP commands need (number, bool, string, null,
// object, ecma-array, strict-array). Decode returns plain Go values; encode uses
// pre-encoded value bytes so object key order is deterministic (RTMP connect
// commands are order-sensitive).
package rtmp

import (
	"encoding/binary"
	"math"
)

// ---- decode ----

type amfReader struct {
	b []byte
	i int
}

func (r *amfReader) u8() byte    { v := r.b[r.i]; r.i++; return v }
func (r *amfReader) u16() uint16 { v := binary.BigEndian.Uint16(r.b[r.i:]); r.i += 2; return v }
func (r *amfReader) u32() uint32 { v := binary.BigEndian.Uint32(r.b[r.i:]); r.i += 4; return v }
func (r *amfReader) f64() float64 {
	bits := binary.BigEndian.Uint64(r.b[r.i:])
	r.i += 8
	return math.Float64frombits(bits)
}
func (r *amfReader) str() string {
	n := int(r.u16())
	s := string(r.b[r.i : r.i+n])
	r.i += n
	return s
}

func (r *amfReader) value() interface{} {
	switch r.u8() {
	case 0x00: // number
		return r.f64()
	case 0x01: // boolean
		return r.u8() != 0
	case 0x02: // string
		return r.str()
	case 0x05, 0x06, 0x0d: // null / undefined / unsupported
		return nil
	case 0x08: // ecma array — u32 count, then object body
		r.u32()
		return r.object()
	case 0x03: // object
		return r.object()
	case 0x0a: // strict array
		n := r.u32()
		arr := make([]interface{}, 0, n)
		for k := uint32(0); k < n; k++ {
			arr = append(arr, r.value())
		}
		return arr
	default:
		return nil
	}
}

func (r *amfReader) object() map[string]interface{} {
	o := map[string]interface{}{}
	for r.i < len(r.b) {
		klen := int(r.u16())
		if klen == 0 { // terminator: 0x00 0x00 then 0x09 marker
			r.u8()
			break
		}
		key := string(r.b[r.i : r.i+klen])
		r.i += klen
		o[key] = r.value()
	}
	return o
}

// amfDecodeAll reads AMF0 values until the buffer is exhausted.
func AmfDecodeAll(b []byte) []interface{} {
	r := &amfReader{b: b}
	out := []interface{}{}
	for r.i < len(r.b) {
		out = append(out, r.value())
	}
	return out
}

// ---- encode ----

func encNumber(v float64) []byte {
	out := make([]byte, 9)
	out[0] = 0x00
	binary.BigEndian.PutUint64(out[1:], math.Float64bits(v))
	return out
}

func encString(s string) []byte {
	out := make([]byte, 3+len(s))
	out[0] = 0x02
	binary.BigEndian.PutUint16(out[1:3], uint16(len(s)))
	copy(out[3:], s)
	return out
}

func encNull() []byte { return []byte{0x05} }

// prop is an ordered object member: key + already-encoded AMF value bytes.
type prop struct {
	k string
	v []byte
}

func encObject(props []prop) []byte {
	out := []byte{0x03}
	for _, p := range props {
		kb := make([]byte, 2)
		binary.BigEndian.PutUint16(kb, uint16(len(p.k)))
		out = append(out, kb...)
		out = append(out, p.k...)
		out = append(out, p.v...)
	}
	return append(out, 0x00, 0x00, 0x09) // object-end marker
}

// ---- command payloads ----

// connect-OK: _result(txn) + server props + info{NetConnection.Connect.Success}.
func CmdConnectOK(txn float64) []byte {
	out := encString("_result")
	out = append(out, encNumber(txn)...)
	out = append(out, encObject([]prop{
		{"fmsVer", encString("FMS/3,5,3,888")},
		{"capabilities", encNumber(127)},
		{"mode", encNumber(1)},
	})...)
	out = append(out, encObject([]prop{
		{"level", encString("status")},
		{"code", encString("NetConnection.Connect.Success")},
		{"description", encString("Connection succeeded.")},
		{"objectEncoding", encNumber(0)},
	})...)
	return out
}

// _error with a free-form description — used for the authmod challenge/response.
func CmdError(txn float64, desc string) []byte {
	out := encString("_error")
	out = append(out, encNumber(txn)...)
	out = append(out, encNull()...)
	out = append(out, encObject([]prop{
		{"level", encString("error")},
		{"code", encString("NetConnection.Connect.Rejected")},
		{"description", encString(desc)},
	})...)
	return out
}

func CmdCreateStreamResult(txn, sid float64) []byte {
	out := encString("_result")
	out = append(out, encNumber(txn)...)
	out = append(out, encNull()...)
	return append(out, encNumber(sid)...)
}

func CmdResultEmpty(txn float64) []byte {
	out := encString("_result")
	out = append(out, encNumber(txn)...)
	return append(out, encNull()...)
}

func CmdOnStatusPublishStart() []byte {
	out := encString("onStatus")
	out = append(out, encNumber(0)...)
	out = append(out, encNull()...)
	out = append(out, encObject([]prop{
		{"level", encString("status")},
		{"code", encString("NetStream.Publish.Start")},
		{"description", encString("Started publishing stream.")},
	})...)
	return out
}

// onStatus with an error level/code — used to reject publishes that skipped the
// auth path their event requires (per-event enforcement at publish time).
func CmdOnStatusError(code, desc string) []byte {
	out := encString("onStatus")
	out = append(out, encNumber(0)...)
	out = append(out, encNull()...)
	out = append(out, encObject([]prop{
		{"level", encString("error")},
		{"code", encString(code)},
		{"description", encString(desc)},
	})...)
	return out
}

// Upstream (gateway → SRS) client commands.

func CmdConnect(app, tcURL string) []byte {
	out := encString("connect")
	out = append(out, encNumber(1)...) // txn 1
	out = append(out, encObject([]prop{
		{"app", encString(app)},
		{"type", encString("nonprivate")},
		{"flashVer", encString("FMLE/3.0 (compatible; media-node)")},
		{"tcUrl", encString(tcURL)},
	})...)
	return append(out, encNull()...)
}

func CmdCreateStream() []byte {
	out := encString("createStream")
	out = append(out, encNumber(2)...)
	return append(out, encNull()...)
}

// publish(streamName, "live") — the stream name is replayed verbatim from OBS so
// SRS' on_publish hook sees the same "<email>?token=<publishKey>" and event auth
// (authorizePublish) is unchanged.
func CmdPublish(name string) []byte {
	out := encString("publish")
	out = append(out, encNumber(0)...)
	out = append(out, encNull()...)
	out = append(out, encString(name)...)
	return append(out, encString("live")...)
}
