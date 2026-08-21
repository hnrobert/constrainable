/**
 * Drizzle schema for constrainable-ingest (SQLite via bun:sqlite).
 *
 * One schema file mirroring kaleidodanmu's single-entities-file convention,
 * but expressed with Drizzle. Snake_case DB columns, camelCase TS accessors.
 */
import { sqliteTable, integer, text, real, index, unique, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

const now = sql`(unixepoch())`

/* ---------------------------------- users --------------------------------- */
// Email is the login identifier + verified at registration via a 6-digit code
// (see server/utils/email-code.ts). Mirrors unnc-freshmen-verifier-gateway.
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /**
   * Adobe RTMP `authmod` account-auth (optional). When a publisher authenticates
   * via OBS "Use authentication", the server needs `salted2 =
   * base64(md5(email + salt + password))` to verify the response. `salt` is a
   * stable query-safe per-user value; the verifier is stored as AES-256-GCM
   * ciphertext (a password-equivalent — must not leak from a bare DB dump).
   * Minted at registration (plaintext in scope) and lazily backfilled on login.
   * See server/utils/authmod.ts + docs/STREAMING.md.
   */
  authmodSalt: text('authmod_salt'),
  authmodVerifier: text('authmod_verifier'),
  /** admin = full management + watching; user = browse authorized events only. */
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  /** media node this user is pinned to for ingest (null = not yet assigned). */
  nodeId: text('node_id'),
  /**
   * The user's OWN dashboard note (a personal reminder shown on their
   * dashboard home). Private to the user — admins neither see nor edit it via
   * the user management UI. null/'' = no note card.
   */
  dashboardNotice: text('dashboard_notice'),
  /**
   * Admin-authored announcement aimed at THIS user — shown on their dashboard
   * home as "Announcement for you" (set from the Users page). Distinct from
   * the global site notice (config dashboard.notice) and from the user's own
   * note above. null/'' = card hidden.
   */
  announcement: text('announcement'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
})

/* ------------------------------ node_settings ----------------------------- */
/**
 * Per-node assignment quota. `maxUsers` caps AUTO-assignment (first-visit
 * lowest-latency allocation); the allocator overfills only when every node is
 * at capacity, then picks the least-overloaded one. Manual admin assignment
 * ignores the cap. Rows are created lazily — absent row = default.
 */
export const nodeSettings = sqliteTable('node_settings', {
  nodeId: text('node_id').primaryKey(),
  maxUsers: integer('max_users').notNull().default(50),
})
export type NodeSetting = typeof nodeSettings.$inferSelect

/* ----------------------------- node_latencies ----------------------------- */
/**
 * Last-visit latency snapshot per (user, node), measured by the browser on
 * every visit and upserted — exactly one row per pair ("the latency from the
 * user's most recent visit"). Feeds the admin matrix + the first-visit
 * allocator.
 */
export const nodeLatencies = sqliteTable(
  'node_latencies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    measuredAt: integer('measured_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [uniqueIndex('node_latency_user_node_uq').on(t.userId, t.nodeId)],
)

/* ------------------------------- app_config ------------------------------- */
export const appConfig = sqliteTable('app_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
})

/* --------------------------------- events --------------------------------- */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    startsAt: integer('starts_at', { mode: 'timestamp' }),
    endsAt: integer('ends_at', { mode: 'timestamp' }),
    status: text('status', { enum: ['draft', 'scheduled', 'live', 'ended', 'archived'] })
      .notNull()
      .default('draft'),
    /** JSON: per-event limits override (null fields = inherit global) */
    limitsOverride: text('limits_override'),
    recordEnabled: integer('record_enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * Strict limits: when ON, a stream that violates the event's limits is
     * stopped immediately AND the publisher is banned from this event (same
     * enforcement as a manual ban — every reconnect is refused at policy).
     */
    strictLimits: integer('strict_limits', { mode: 'boolean' }).notNull().default(false),
    /**
     * ALSO enforce limits on MEASURED stream data (5s counter deltas from the
     * node monitor). Off by default — the DECLARED spec (onMetaData) is the
     * baseline gate; measured enforcement catches mid-stream changes and
     * forged declarations, per event.
     */
    enforceMeasuredLimits: integer('enforce_measured_limits', { mode: 'boolean' }).notNull().default(false),
    /**
     * When true, OBS publishers must authenticate with their website account
     * (email + login password) via OBS' native "Use authentication" fields. The
     * Go RTMP gateway front-door performs the Adobe authmod challenge-response;
     * SRS still does event auth (publish key) via on_publish, unchanged.
     */
    requireAccountAuth: integer('require_account_auth', { mode: 'boolean' }).notNull().default(true),
    /**
     * Who may see this event in catalogs/details:
     *   public     — anyone (incl. outsiders, on the homepage)
     *   registered — any logged-in user (the default)
     *   groups     — only members of the event's linked groups (event_groups)
     */
    visibility: text('visibility', { enum: ['public', 'registered', 'groups'] })
      .notNull()
      .default('registered'),
    /** argon2id hash of the per-event publish token (alternative to per-student stream keys). */
    publishTokenHash: text('publish_token_hash'),
    /** first chars of the plaintext token — indexed for on_publish prefix lookup. */
    publishTokenPrefix: text('publish_token_prefix'),
    /**
     * Shared, retrievable event publish key shown on the participant guide and
     * used as `?token=`. Stored verbatim (not hashed) so it can be redisplayed;
     * it is a shared credential handed to everyone authorized to view the event,
     * so it is not a per-person secret. The stream *name* (username) stays unique
     * per contestant, so concurrent publishing still works with one shared key.
     */
    publishKey: text('publish_key'),
    /** admin-authored custom instructions rendered atop the participant guide. */
    streamGuide: text('stream_guide'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [
    index('events_status_idx').on(t.status),
    index('events_publish_token_prefix_idx').on(t.publishTokenPrefix),
    index('events_publish_key_idx').on(t.publishKey),
  ],
)

/* -------------------------------- stream_bans ------------------------------- */
/**
 * Streaming bans (小黑屋). `eventId` NULL = site-wide; otherwise scoped to one
 * event. Bans are permanent until lifted; enforced at the RTMP gateway's salt
 * stage (site-wide, by account email) and publish-policy stage (both scopes).
 */
export const streamBans = sqliteTable(
  'stream_bans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** the banned publisher's account email (gateway identity) */
    email: text('email').notNull(),
    /** null = site-wide; otherwise the ban applies to this event only */
    eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    bannedBy: text('banned_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [unique('uq_stream_bans_scope').on(t.email, t.eventId)],
)

/* ---------------------------- event_slug_aliases --------------------------- */
/**
 * Renamed-event redirects: when an event's key (slug) changes, the old key
 * 301s visitors to the new one — until a NEW event claims the old key, at
 * which point the alias is dropped (the old key serves the new event).
 */
export const eventSlugAliases = sqliteTable('event_slug_aliases', {
  /** the retired key a visitor may still use */
  oldSlug: text('old_slug').primaryKey(),
  eventId: integer('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
})

/* -------------------------------- students -------------------------------- */
export const students = sqliteTable(
  'students',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** student ID */
    studentNumber: text('student_number').notNull().unique(),
    name: text('name').notNull(),
    email: text('email'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
)

/* ---------------------------- event_enrollments --------------------------- */
export const eventEnrollments = sqliteTable(
  'event_enrollments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    seatLabel: text('seat_label'),
    status: text('status', { enum: ['invited', 'active', 'absent', 'done'] })
      .notNull()
      .default('invited'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [
    unique('uq_enrollment_event_student').on(t.eventId, t.studentId),
    index('enrollment_event_idx').on(t.eventId),
    index('enrollment_student_idx').on(t.studentId),
  ],
)

/* ------------------------------- stream_keys ------------------------------ */
export const streamKeys = sqliteTable(
  'stream_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    enrollmentId: integer('enrollment_id').references(() => eventEnrollments.id, {
      onDelete: 'set null',
    }),
    /** SRS stream name — what the publisher pushes as the RTMP stream key */
    streamName: text('stream_name').notNull(),
    /** argon2id hash of the secret token (OBS key = `${streamName}?token=...`) */
    tokenHash: text('token_hash').notNull(),
    /** first/last chars for display, e.g. `abcd…wxyz` */
    tokenPreview: text('token_preview').notNull(),
    revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [
    // hot path: on_publish resolves by streamName
    index('stream_keys_name_idx').on(t.streamName),
    unique('uq_stream_keys_event_name').on(t.eventId, t.streamName),
    index('stream_keys_event_idx').on(t.eventId),
  ],
)

/* ----------------------------- publish_sessions --------------------------- */
export const publishSessions = sqliteTable(
  'publish_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
    streamKeyId: integer('stream_key_id').references(() => streamKeys.id, {
      onDelete: 'set null',
    }),
    streamName: text('stream_name').notNull(),
    /** null = local/dev session (app manages its own SRS); else the media node id */
    nodeId: text('node_id'),
    /** last publish:metrics arrival — remote-session liveness for the reconciler */
    lastMetricAt: integer('last_metric_at', { mode: 'timestamp' }),
    srsClientId: text('srs_client_id'),
    status: text('status', {
      enum: ['pending', 'allowed', 'rejected', 'compliant', 'violating', 'killed', 'ended'],
    })
      .notNull()
      .default('pending'),
    rejectReason: text('reject_reason'),
    width: integer('width'),
    height: integer('height'),
    fps: real('fps'),
    /** video-only estimate (total minus declared audio) */
    videoBitrateKbps: integer('video_bitrate_kbps'),
    /** the publisher's declared AUDIO rate (OBS Audio Bitrate field) */
    audioBitrateKbps: integer('audio_bitrate_kbps'),
    compliant: integer('compliant', { mode: 'boolean' }).notNull().default(false),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(now),
    endedAt: integer('ended_at', { mode: 'timestamp' }),
  },
  (t) => [
    index('sessions_status_event_idx').on(t.status, t.eventId),
    index('sessions_stream_name_idx').on(t.streamName),
    index('sessions_event_idx').on(t.eventId),
  ],
)

/* ------------------------------- recordings ------------------------------- */
export const recordings = sqliteTable(
  'recordings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
    sessionId: integer('session_id').references(() => publishSessions.id, {
      onDelete: 'set null',
    }),
    streamName: text('stream_name').notNull(),
    studentLabel: text('student_label'),
    /**
     * Which media node holds the segment FILES (null = on this app's disk,
     * under RECORD_DIR). Node recordings are served by RELAYING the bytes
     * over the socket control channel (node:rec:* events).
     */
    nodeId: text('node_id'),
    /**
     * JSON array of segment file paths (relative to RECORD_DIR), in
     * chronological order — real-time MKV files, one per publish. Appending a
     * user's re-publish just grows this list; no stop-time transcoding. Merge
     * into a single stream happens on demand at playback/download time.
     */
    segments: text('segments'),
    /** path relative to RECORD_DIR — the FIRST segment (compat for old rows) */
    filePath: text('file_path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** cumulative duration across merged segments (same user re-publishing) */
    durationSec: real('duration_sec'),
    /** average fps across merged segments */
    avgFps: real('avg_fps'),
    width: integer('width'),
    height: integer('height'),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(now),
    /** end of the LATEST merged segment */
    endedAt: integer('ended_at', { mode: 'timestamp' }),
    retainedUntil: integer('retained_until', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [
    index('recordings_event_started_idx').on(t.eventId, t.startedAt),
    index('recordings_session_idx').on(t.sessionId),
    index('recordings_retained_idx').on(t.retainedUntil),
  ],
)

/* -------------------------------- audit_log ------------------------------- */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts', { mode: 'timestamp' }).notNull().default(now),
    level: text('level', { enum: ['info', 'warn', 'error'] }).notNull().default('info'),
    category: text('category', {
      enum: ['auth', 'publish', 'access', 'config', 'recording', 'system', 'admin'],
    }).notNull(),
    /**
     * WHO performed the action: the acting account's email (publisher, login,
     * …). null = system/background jobs or rows written before the column
     * existed. Drives the per-user "My audit" view — keyed by email on
     * purpose: an append-only log survives account deletion (no FK).
     */
    actor: text('actor'),
    eventId: integer('event_id'),
    streamName: text('stream_name'),
    message: text('message').notNull(),
    /** JSON detail */
    detail: text('detail'),
  },
  (t) => [index('audit_ts_idx').on(t.ts), index('audit_event_idx').on(t.eventId)],
)

/* --------------------------------- groups --------------------------------- */
// Arbitrary user groupings. An event set to visibility 'groups' is only visible
// to users who are a member of at least one of its linked groups (event_groups).
export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
})

/* user ↔ group membership (many-to-many) */
export const userGroups = sqliteTable(
  'user_groups',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] }), index('user_groups_group_idx').on(t.groupId)],
)

/* event ↔ group scoping (many-to-many); consulted when visibility = 'groups' */
export const eventGroups = sqliteTable(
  'event_groups',
  {
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.groupId] }), index('event_groups_group_idx').on(t.groupId)],
)

/* ------------------------------ invite_links ------------------------------ */
// Single-use-ish invite codes that grant membership in a group. Registering with
// `?invite=CODE` auto-joins the group; an existing user can claim one too.
// Code is a 24-char hex string (opaque, unguessable), per the verifier gateway.
export const inviteLinks = sqliteTable(
  'invite_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull().unique(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** null = unlimited uses */
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** admin-facing label for the link */
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
  },
  (t) => [index('invite_group_idx').on(t.groupId), index('invite_code_idx').on(t.code)],
)

/* ------------------------------- relations -------------------------------- */
// Drizzle relations enable the relational query API (db.query.events.findMany({...})).
// Kept minimal; services mostly use SQL-style builders for hot paths.
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Event = typeof events.$inferSelect
export type EventSlugAlias = typeof eventSlugAliases.$inferSelect
export type StreamBan = typeof streamBans.$inferSelect
export type NewStreamBan = typeof streamBans.$inferInsert
export type NewEventSlugAlias = typeof eventSlugAliases.$inferInsert
export type NewEvent = typeof events.$inferInsert
export type Student = typeof students.$inferSelect
export type NewStudent = typeof students.$inferInsert
export type Enrollment = typeof eventEnrollments.$inferSelect
export type NewEnrollment = typeof eventEnrollments.$inferInsert
export type StreamKey = typeof streamKeys.$inferSelect
export type NewStreamKey = typeof streamKeys.$inferInsert
export type PublishSession = typeof publishSessions.$inferSelect
export type NewPublishSession = typeof publishSessions.$inferInsert
export type Recording = typeof recordings.$inferSelect
export type NewRecording = typeof recordings.$inferInsert
export type AuditEntry = typeof auditLog.$inferSelect
export type NewAuditEntry = typeof auditLog.$inferInsert
export type AppConfigRow = typeof appConfig.$inferSelect
export type Group = typeof groups.$inferSelect
export type NewGroup = typeof groups.$inferInsert
export type UserGroup = typeof userGroups.$inferSelect
export type NewUserGroup = typeof userGroups.$inferInsert
export type EventGroup = typeof eventGroups.$inferSelect
export type NewEventGroup = typeof eventGroups.$inferInsert
export type InviteLink = typeof inviteLinks.$inferSelect
export type NewInviteLink = typeof inviteLinks.$inferInsert
