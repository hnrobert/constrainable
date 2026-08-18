/** Small Bun.spawn helpers shared by probe + recorder services. */
import type { Subprocess } from 'bun'

/** Any Bun subprocess regardless of stdio generics. */
export type AnyProc = Subprocess<'pipe' | 'ignore' | null, 'pipe' | 'ignore' | null, 'pipe' | 'ignore' | null>

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const encoder = new TextEncoder()

/**
 * Wait for a subprocess to exit, force-killing it after `timeoutMs`.
 * Returns the exit code if it exited in time, or `null` if it was killed.
 */
export async function awaitExitOrKill(proc: AnyProc, timeoutMs: number): Promise<number | null> {
  const result = await Promise.race([
    proc.exited.then((code) => ({ done: true as const, code })),
    sleep(timeoutMs).then(() => ({ done: false as const, code: 0 })),
  ])
  if (result.done) return result.code
  try {
    proc.kill()
  } catch {
    // already dead
  }
  return null
}

/** Send 'q' (graceful quit) to an ffmpeg recorder's stdin, then await or kill. */
export async function quitFfmpeg(proc: AnyProc, timeoutMs: number): Promise<number | null> {
  try {
    const stdin = proc.stdin as import('bun').FileSink | null | undefined
    if (stdin) {
      stdin.write(encoder.encode('q'))
      stdin.end()
    }
  } catch {
    // ignore
  }
  return awaitExitOrKill(proc, timeoutMs)
}

/** Read a piped stdout/stderr stream fully to a string. */
export async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  return await new Response(stream).text()
}
