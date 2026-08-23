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
}
