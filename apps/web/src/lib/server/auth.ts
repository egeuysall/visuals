import "server-only";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { db, takeToday } from "./db";

const COOKIE = "sdk_session";
const MAX_AGE = 60 * 60 * 24 * 7;
// A 4 digit pin has only 10,000 values, so guessing is stopped by the lockout, not by the hash.
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
// Per network address and day.
const SIGN_UPS_PER_ADDRESS = 10;
const SIGN_INS_PER_ADDRESS = 100;

export interface User {
  id: string;
  username: string;
}

const store = globalThis as { devSecret?: string };

function secret(): string {
  const env = process.env.SESSION_SECRET;
  if (env && env.length >= 32) return env;
  if (process.env.NODE_ENV === "production")
    throw new Error("SESSION_SECRET (32+ characters) is required");
  // Development only: sessions end when the dev server restarts.
  store.devSecret ??= randomBytes(32).toString("hex");
  return store.devSecret;
}

const sign = (payload: string) =>
  createHmac("sha256", secret()).update(payload).digest("base64url");
const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString("hex");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** True while this network address is under its daily cap. The address itself is never stored. */
export async function allowAddress(action: "sign-up" | "sign-in"): Promise<boolean> {
  const address = (await headers()).get("cf-connecting-ip") ?? "local";
  const limit = action === "sign-up" ? SIGN_UPS_PER_ADDRESS : SIGN_INS_PER_ADDRESS;
  return takeToday(`${action}:${sign(address)}`, limit);
}

export function validateCredentials(username: string, pin: string): string | null {
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return "username: 3 to 24 of a-z, 0-9 or _.";
  if (!/^\d{4}$/.test(pin)) return "pin: exactly 4 digits.";
  return null;
}

export async function createUser(username: string, pin: string): Promise<User | { error: string }> {
  const salt = randomBytes(16).toString("hex");
  // The id, not the username, names the user's memory, so a re-created name never inherits it.
  const id = randomUUID();
  const { meta } = await db()
    .prepare("INSERT OR IGNORE INTO users (id, username, pin_hash, salt) VALUES (?, ?, ?, ?)")
    .bind(id, username, hashPin(pin, salt), salt)
    .run();
  return meta.changes === 1 ? { id, username } : { error: "that username is taken." };
}

export async function checkUser(username: string, pin: string): Promise<User | { error: string }> {
  const wrong = { error: "wrong username or pin." };
  const locked = { error: "too many attempts. try again in 15 min." };
  const now = Date.now();

  // The attempt is counted before the pin is looked at. Counting afterwards would let many
  // guesses sent at the same moment all get through before the first one was recorded.
  const row = await db()
    .prepare(
      `UPDATE users SET failed = failed + 1 WHERE username = ? AND locked_until <= ?
       RETURNING id, pin_hash, salt, failed`,
    )
    .bind(username, now)
    .first<{ id: string; pin_hash: string; salt: string; failed: number }>();
  if (!row) {
    const exists = await db()
      .prepare("SELECT 1 AS found FROM users WHERE username = ?")
      .bind(username)
      .first();
    return exists ? locked : wrong;
  }

  const correct = row.failed <= MAX_FAILURES && same(hashPin(pin, row.salt), row.pin_hash);
  if (correct) {
    await db()
      .prepare("UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?")
      .bind(row.id)
      .run();
    return { id: row.id, username };
  }
  if (row.failed >= MAX_FAILURES) {
    await db()
      .prepare("UPDATE users SET failed = 0, locked_until = ? WHERE id = ?")
      .bind(now + LOCK_MS, row.id)
      .run();
  }
  return row.failed > MAX_FAILURES ? locked : wrong;
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
  return db().prepare("SELECT id, username FROM users WHERE id = ?").bind(id).first<User>();
}
