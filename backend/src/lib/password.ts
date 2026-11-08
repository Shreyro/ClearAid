import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt password hashes, stored as "salt:hash" in hex. */
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(password, salt, want.length);
  return timingSafeEqual(want, got);
}
