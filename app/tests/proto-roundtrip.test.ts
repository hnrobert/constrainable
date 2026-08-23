import { describe, expect, test } from 'bun:test'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { EnvelopeSchema } from '../shared/proto/control/v1/control_pb'

// Fixture generated on the Go side — regenerate with:
//   cd node && go test ./node -run TestEnvelopeFixture -v
const GO_FIXTURE_B64 = 'KiIIBzoeCgRkZW1vEhZ2PTANCm9mZmVyLXNkcC1ieXRlcwD/'

describe('control.v1 envelope', () => {
  test('decodes the Go-encoded envelope and re-encodes byte-identically', () => {
    const bin = new Uint8Array(Buffer.from(GO_FIXTURE_B64, 'base64'))
    const env = fromBinary(EnvelopeSchema, bin)

    expect(env.kind?.case).toBe('rpcRequest')
    const req = env.kind?.case === 'rpcRequest' ? env.kind.value : undefined
    expect(req?.seq).toBe(7)
    expect(req?.body?.case).toBe('whepRelay')
    const whep = req?.body?.case === 'whepRelay' ? req.body.value : undefined
    expect(whep?.streamName).toBe('demo')
    expect(Buffer.from(whep?.offerSdp ?? []).toString('hex')).toBe('763d300d0a6f666665722d7364702d627974657300ff')

    const re = toBinary(EnvelopeSchema, env)
    expect(Buffer.compare(Buffer.from(bin), Buffer.from(re))).toBe(0)
  })
})
