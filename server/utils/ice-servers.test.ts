import { describe, expect, it } from 'bun:test'
import { parseIceServers } from './env'

describe('parseIceServers', () => {
  it('empty → []', () => {
    expect(parseIceServers('')).toEqual([])
    expect(parseIceServers('   ')).toEqual([])
  })

  it('JSON array with TURN credentials passes through', () => {
    const out = parseIceServers(
      JSON.stringify([
        { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
        { urls: 'stun:stun.example.com:19302' },
      ]),
    )
    expect(out).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
      { urls: 'stun:stun.example.com:19302' },
    ])
  })

  it('comma list of URLs', () => {
    expect(parseIceServers('stun:a:1, stun:b:2')).toEqual([
      { urls: 'stun:a:1' },
      { urls: 'stun:b:2' },
    ])
  })

  it('turn:user:pass@host shorthand → credentials extracted', () => {
    expect(parseIceServers('turn:alice:s3cret@turn.example.com:3478')).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'alice', credential: 's3cret' },
    ])
  })

  it('malformed JSON → []', () => {
    expect(parseIceServers('[{broken')).toEqual([])
  })

  it('JSON non-array → []', () => {
    expect(parseIceServers('{"urls":"stun:x"}')).toEqual([])
  })

  it('JSON entries without urls are dropped', () => {
    expect(parseIceServers(JSON.stringify([{ urls: '' }, { username: 'x' }, { urls: 'stun:ok:1' }]))).toEqual([
      { urls: 'stun:ok:1' },
    ])
  })
})
