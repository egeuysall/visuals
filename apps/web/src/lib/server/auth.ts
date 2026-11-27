import "server-only";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cookies } from "next/headers";
import { dataDir } from "./data-dir";
import { db } from "./db";

const COOKIE = "visuals_session";
const MAX_AGE = 60 * 60 * 24 * 7;
// A 4 digit pin has only 10,000 values, so guessing is stopped by the lockout, not by the hash.
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export interface User {
  id: string;
  username: string;
}

function secret(): string {
  const env = process.env.SESSION_SECRET;
  if (env && env.length >= 32) return env;
  if (process.env.NODE_ENV === "production")
    throw new Error("SESSION_SECRET (32+ characters) is required");
  const file = join(dataDir(), "session-secret");
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch {
    // already created
  }
  return readFileSync(file, "utf8");
}

const sign = (payload: string) =>
  createHmac("sha256", secret()).update(payload).digest("base64url");
const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString("hex");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function validateCredentials(username: string, pin: string): string | null {
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return "username: 3 to 24 of a-z, 0-9 or _.";
  if (!/^\d{4}$/.test(pin)) return "pin: exactly 4 digits.";
  return null;
}

export function createUser(username: string, pin: string): User | { error: string } {
  const salt = randomBytes(16).toString("hex");
  // The id, not the username, names the user's memory, so a re-created name never inherits it.
  const id = randomUUID();
  const r = db()
    .prepare("INSERT OR IGNORE INTO users (id, username, pin_hash, salt) VALUES (?, ?, ?, ?)")
    .run(id, username, hashPin(pin, salt), salt);
  return Number(r.changes) === 1 ? { id, username } : { error: "that username is taken." };
}

export function checkUser(username: string, pin: string): User | { error: string } {
  const row = db().prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | { id: string; pin_hash: string; salt: string; locked_until: number }
    | undefined;
  const wrong = { error: "wrong username or pin." };
  if (!row) return wrong;
  const now = Date.now();
  if (row.locked_until > now)
    return {
      error: `too many attempts. try again in ${Math.ceil((row.locked_until - now) / 60_000)} min.`,
    };
  if (!same(hashPin(pin, row.salt), row.pin_hash)) {
    db()
      .prepare(
        `UPDATE users SET
           locked_until = CASE WHEN failed + 1 >= ? THEN ? ELSE locked_until END,
           failed = CASE WHEN failed + 1 >= ? THEN 0 ELSE failed + 1 END
         WHERE id = ?`,
      )
      .run(MAX_FAILURES, now + LOCK_MS, MAX_FAILURES, row.id);
    return wrong;
  }
  db().prepare("UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?").run(row.id);
  return { id: row.id, username };
}

export async function startSession(userId: string): Promise<void> {
  const payload = `${userId}.${Date.now() + MAX_AGE * 1000}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in user, from the cookie only. Nothing the client sends can name another user. */
export async function currentUser(): Promise<User | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return null;
  const [id, expires, mac] = value.split(".");
  if (!id || !expires || !mac || !same(mac, sign(`${id}.${expires}`))) return null;
  if (Number(expires) < Date.now()) return null;
  const row = db().prepare("SELECT id, username FROM users WHERE id = ?").get(id) as
    | User
    | undefined;
  return row ? { id: row.id, username: row.username } : null;
}
