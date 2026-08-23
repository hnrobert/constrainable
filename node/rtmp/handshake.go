// RTMP handshake — simple (non-digest) variant, which OBS/librtmp and SRS both
// accept. Server side (with OBS) ports the proven Python echo-handshake; client
// side (to SRS) does the standard C0/C1 → S0/S1/S2 → C2 dance.
package rtmp

import (
	"crypto/rand"
	"errors"
	"net"
)

var errBadHandshake = errors.New("invalid RTMP handshake (version != 3)")

// serverHandshake: read C0+C1, reply S0+S1+S2(=C1), read C2.
func ServerHandshake(c net.Conn) error {
	c0, err := ReadN(c, 1)
	if err != nil {
		return err
	}
	if c0[0] != 0x03 {
		return errBadHandshake
	}
	c1, err := ReadN(c, 1536)
	if err != nil {
		return err
	}
	// S1: time(4)=0, version(4)=client's time field, rest zeros. (Matches the
	// Python responder that OBS already negotiated against.)
	s1 := make([]byte, 1536)
	copy(s1[4:8], c1[0:4])
	// S0(0x03) || S1 || S2(=C1 echo)
	if _, err := c.Write(append(append([]byte{0x03}, s1...), c1...)); err != nil {
		return err
	}
	if _, err := ReadN(c, 1536); err != nil { // C2
		return err
	}
	return nil
}

// clientHandshake: C0+C1(rand) → read S0+S1+S2 → C2(=S1 echo).
func ClientHandshake(c net.Conn) error {
	c1 := make([]byte, 1536)
	if _, err := rand.Read(c1); err != nil {
		return err
	}
	if _, err := c.Write(append([]byte{0x03}, c1...)); err != nil {
		return err
	}
	if _, err := ReadN(c, 1); err != nil { // S0
		return err
	}
	s1, err := ReadN(c, 1536)
	if err != nil {
		return err
	}
	if _, err := ReadN(c, 1536); err != nil { // S2
		return err
	}
	_, err = c.Write(s1) // C2 = S1
	return err
}
