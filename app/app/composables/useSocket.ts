/**
 * Dashboard realtime — native WebSocket against /ws/admin (the Bun gateway),
 * successor of the socket.io client. Exposes the SAME consumer surface the
 * socket.io client had (.on(event, cb), synthetic 'connect' / 'disconnect'),
 * so pages are unchanged; server frames are JSON [eventName, payload].
 *
 * Connection policy: same-origin by default (the reverse proxy routes /ws/*
 * to the gateway; the Vite dev server proxies it too — see nuxt.config.ts).
 * Split deployments (API_ORIGIN set) dial the API origin instead, and the
 * session cookie rides the handshake automatically (same-origin WS always
 * sends cookies; cross-origin browsers send them for WebSocket handshakes).
 *
 * Liveness: an app-level "ping" every 25s (server replies "pong", drops the
 * connection after 90s of silence) keeps intermediaries from idling us out.
 * Reconnect: fixed 3s, forever — pages refetch state on 'connect'.
 *
 * Client-only: call from onMounted / a .client plugin (no window on SSR).
 */

type Handler = (payload: never) => void

class LiveSocket {
  private handlers = new Map<string, Set<Handler>>()
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false

  constructor(private url: string) {
    this.connect()
  }

  private connect(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.emit('connect')
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
      }, 25_000)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      if (ev.data === 'pong') return
      try {
        const [name, payload] = JSON.parse(ev.data) as [string, unknown]
        if (typeof name === 'string') this.emit(name, payload)
      } catch {
        // non-JSON frame — ignore
      }
    }
    ws.onclose = () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      this.emit('disconnect')
      if (!this.closedByUs) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3_000)
      }
    }
    ws.onerror = () => {
      // handshake failures (403) surface as onclose → the reconnect loop
      // backs off; a permanent 403 just retries harmlessly every 3s
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }

  on(event: string, cb: Handler): this {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(cb)
    return this
  }

  off(event: string, cb: Handler): this {
    this.handlers.get(event)?.delete(cb)
    return this
  }

  private emit(event: string, payload?: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) {
      try {
        // `never`-typed parameter makes every handler signature assignable
        ;(cb as (p: unknown) => void)(payload)
      } catch (err) {
        console.error(`[live-socket] handler for ${event} threw:`, err)
      }
    }
  }

  close(): void {
    this.closedByUs = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close()
  }
}

let _socket: LiveSocket | null = null

function wsUrl(): string {
  // split deployment: dial the API origin (http→ws), else same-origin
  const apiOrigin = String(useRuntimeConfig().public.apiOrigin || '')
  if (apiOrigin.startsWith('http')) {
    return apiOrigin.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/admin'
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws/admin`
}

export function useSocket(): LiveSocket {
  if (_socket) return _socket
  _socket = new LiveSocket(wsUrl())
  return _socket
}

export function disposeSocket(): void {
  _socket?.close()
  _socket = null
}
