package rtmp

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"
)

// Hand-encode AMF0 exactly as OBS/librtmp sends onMetaData:
// ["@setDataFrame", "onMetaData", {width, height, framerate, videodatarate, audiodatarate}]
func encodeAMF0Metadata(t *testing.T) []byte {
	var b bytes.Buffer
	str := func(v string) {
		b.WriteByte(0x02)
		var l [2]byte
		binary.BigEndian.PutUint16(l[:], uint16(len(v)))
		b.Write(l[:])
		b.WriteString(v)
	}
	num := func(k string, v float64) {
		str(k)
		b.WriteByte(0x00)
		var f [8]byte
		binary.BigEndian.PutUint64(f[:], math.Float64bits(v))
		b.Write(f[:])
	}
	str("@setDataFrame")
	str("onMetaData")
	b.WriteByte(0x08) // ECMA array
	var c [4]byte
	binary.BigEndian.PutUint32(c[:], 5)
	b.Write(c[:])
	num("width", 1920)
	num("height", 1080)
	num("framerate", 29.97)
	num("videodatarate", 2500)
	num("audiodatarate", 128)
	b.WriteByte(0x09) // object end
	return b.Bytes()
}
