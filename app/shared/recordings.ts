/** Recording catalog item (GET /api/recordings, GET /api/recordings/:id). */
export interface RecordingView {
  id: number
  eventId: number | null
  sessionId: number | null
  streamName: string
  studentLabel: string | null
  filePath: string
  sizeBytes: number
  durationSec: number | null
  /** weighted average fps across merged segments */
  avgFps: number | null
  width: number | null
  height: number | null
  startedAt: number
  /** end of the latest merged segment (epoch ms), or null while recording */
  endedAt: number | null
  retainedUntil: number | null
  createdAt: number
  /** media node hosting the files (null = stored locally on the app) */
  nodeId: string | null
  /** false = hosting node currently disconnected: play/download unavailable,
   * deleting only removes the record (files stay on the node). null = local. */
  nodeOnline: boolean | null
}
