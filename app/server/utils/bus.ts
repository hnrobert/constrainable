/**
 * In-process typed event bus. Services emit; the Socket.IO plugin (Phase 5)
 * subscribes and forwards to connected clients. Pure EventEmitter — no
 * listeners means events are simply dropped (safe in Phase 2).
 */
import { EventEmitter } from 'node:events'
import type { BusEventMap, BusEventName } from '#shared/events'

export const bus = new EventEmitter()
bus.setMaxListeners(0)

export function emit<K extends BusEventName>(event: K, payload: BusEventMap[K]): void {
  bus.emit(event, payload)
}

export function onBus<K extends BusEventName>(event: K, fn: (payload: BusEventMap[K]) => void): () => void {
  bus.on(event, fn as (payload: unknown) => void)
  return () => bus.off(event, fn as (payload: unknown) => void)
}
