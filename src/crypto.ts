import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export type SecretKey = { id: string; key: Buffer };

/** AES-256-GCM, bound to the key id so a value is never opened with the wrong key. */
export function seal(value: string, secret: SecretKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret.key, iv);
  cipher.setAAD(Buffer.from(secret.id));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", secret.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function open(sealed: string, secret: SecretKey): string {
  const [version, id, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || id !== secret.id || !iv || !tag || body === undefined) throw new Error("sealed_value_invalid");
  const decipher = createDecipheriv("aes-256-gcm", secret.key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(secret.id));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** Constant time regardless of the presented value's length. */
export function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
