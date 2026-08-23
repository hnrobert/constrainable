package node

import (
	"bytes"
	"encoding/base64"
	"testing"

	"google.golang.org/protobuf/proto"

	controlv1 "media-node/gen/control/v1"
)

// fixtureEnvelope is the cross-language probe: the TS side decodes the same
// bytes and must re-encode them identically (app/tests/proto-roundtrip.test.ts).
func fixtureEnvelope() *controlv1.Envelope {
	return &controlv1.Envelope{
		Kind: &controlv1.Envelope_RpcRequest{
			RpcRequest: &controlv1.RpcRequest{
				Seq: 7,
				Body: &controlv1.RpcRequest_WhepRelay{
					WhepRelay: &controlv1.WhepRelayRequest{
						StreamName: "demo",
						OfferSdp:   []byte("v=0\r\noffer-sdp-bytes\x00\xff"),
					},
				},
			},
		},
	}
}

func TestEnvelopeRoundtrip(t *testing.T) {
	env := fixtureEnvelope()
	bin, err := proto.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	var back controlv1.Envelope
	if err := proto.Unmarshal(bin, &back); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(env, &back) {
		t.Fatal("roundtrip mismatch")
	}
	rebin, err := proto.Marshal(&back)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bin, rebin) {
		t.Fatal("re-marshal not byte-identical")
	}
}

// TestEnvelopeFixture prints the base64 fixture consumed by the TS test.
// Regenerate with: go test ./node -run TestEnvelopeFixture -v
func TestEnvelopeFixture(t *testing.T) {
	bin, err := proto.Marshal(fixtureEnvelope())
	if err != nil {
		t.Fatal(err)
	}
	t.Log(base64.StdEncoding.EncodeToString(bin))
}
