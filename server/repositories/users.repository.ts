/**
 * users table — data access only. Auth/session reads + registration writes.
 * (kaleidodanmu-style repository: pure Drizzle queries, no business logic, no
 * HTTP errors.) Email is the unique login identifier. `isEmpty()` drives the
 * first-registrant-is-super-admin rule (and the bootstrap code-verification
 * exemption) in the auth handlers, not here.
 */
import { count, desc, eq } from 'drizzle-orm'
import { db } from '../database/db'
import { users, type NewUser, type User } from '../database/schema'

export const UsersRepository = {
  findById(id: number): User | undefined {
    return db.select().from(users).where(eq(users.id, id)).get()
  },
  /** Email is normalized (trimmed + lowercased) before lookup. */
  findByEmail(email: string): User | undefined {
    return db.select().from(users).where(eq(users.email, email)).get()
  },
  /** All users, newest first (admin user-management page). */
  findAll(): User[] {
    return db.select().from(users).orderBy(desc(users.createdAt), desc(users.id)).all()
  },
  count(): number {
    const row = db.select({ n: count() }).from(users).get()
    return row?.n ?? 0
  },
  /** True when no users exist yet → the next registrant becomes super admin. */
  isEmpty(): boolean {
    const row = db.select({ n: count() }).from(users).get()
    return (row?.n ?? 0) === 0
  },
  insert(values: NewUser): User {
    return db.insert(users).values(values).returning().get()
  },
  /** Change a user's role (admin ⇄ user). */
  updateRole(id: number, role: User['role']): void {
    db.update(users).set({ role }).where(eq(users.id, id)).run()
  },
  /** Replace the password hash (used by legacy re-hash on login + future resets). */
  updatePassword(id: number, passwordHash: string): void {
    db.update(users).set({ passwordHash }).where(eq(users.id, id)).run()
  },
  /** Store/rotate the RTMP authmod verifier (stable salt + AES ciphertext). */
  setAuthmod(id: number, salt: string, verifierCipher: string): void {
    db.update(users).set({ authmodSalt: salt, authmodVerifier: verifierCipher }).where(eq(users.id, id)).run()
  },
}
