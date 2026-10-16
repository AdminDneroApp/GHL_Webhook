import { sql } from "drizzle-orm";
import { getDb, type Database, type Tx } from "../client";

// namespace for pg_advisory_xact_lock(int, int), so contact locks never collide with other advisory locks
export const CONTACT_LOCK_NAMESPACE = 41_001;

// per-contact transaction lock. advisory (not FOR UPDATE) so it works before any cycle row exists.
// released automatically at commit/rollback.
export async function lockContact(tx: Tx, ghlContactId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CONTACT_LOCK_NAMESPACE}, hashtext(${ghlContactId}))`);
}

// runs fn in one transaction holding the contact lock — concurrent tag events for a contact run one after another
export async function withContactLock<T>(
  ghlContactId: string,
  fn: (tx: Tx) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockContact(tx, ghlContactId);
    return fn(tx);
  });
}
