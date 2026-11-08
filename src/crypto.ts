import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** Constant time regardless of the presented value's length. */
export function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
