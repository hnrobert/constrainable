// ControlClient is the transport-independent surface of the control-plane
// connection, implemented by BOTH clients: the legacy socket.io Client and
// the protobuf-WebSocket WsClient. main() picks one via CONTROL_TRANSPORT;
// everything downstream (RTMP gate, session manager, recording reports)
// only ever sees this interface.
package node

import "time"

type ControlClient interface {
	Run()
	Close()
	NodeID() string
	IsConnected() bool

	// Emit sends a fire-and-forget report. Payload is one of the report
	// structs (MetricsReport / EndReport / RecordingReady / ViolationReport).
	Emit(event string, payload any) error
	// EmitWithAck sends an RPC-style request and unmarshals the response into
	// result. Event is one of publish:start / publish:spec / auth:salt /
	// auth:verify / auth:policy.
	EmitWithAck(event string, payload any, result any, timeout time.Duration) error

	// RTMP authmod (used by rtmp.AppClient).
	Salt(email string) SaltResult
	Verify(email, opaque, challenge, response string) VerifyResult
	Policy(token, stream string) PolicyResult
	// Declared-spec verdict.
	VerifySpec(p PublishSpec) (SpecVerdict, error)

	// Command handlers (set by the owner before Run).
	SetOnKick(f func(NodeKick))
	SetOnConfig(f func(ConfigLimits))
	SetOnDelete(f func(RecordingDelete) error)
}

// --- socket.io Client setters (field assignment behind the interface) ---

func (c *Client) SetOnKick(f func(NodeKick))                  { c.OnKick = f }
func (c *Client) SetOnConfig(f func(ConfigLimits))            { c.OnConfig = f }
func (c *Client) SetOnDelete(f func(RecordingDelete) error)   { c.OnDelete = f }
