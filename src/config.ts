export type Config = {
  databaseUrl: string;
  relayControlUrl: string;
  introspectSecret: string;
  /** This service's origin, registered in relay-control's accepted audiences. */
  audience: string;
  adminToken: string;
  browserOrigins: string[];
  host: string;
  port: number;
  adminHost: string;
  adminPort: number;
  /** Unset: repository discovery answers 503, so chiefs cannot be created. */
  nango: { host: string; secretKey: string } | null;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) origin`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${name} must be an http(s) origin`);
  }
  return url.origin;
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a port`);
  return value;
}

function nango(env: NodeJS.ProcessEnv): Config["nango"] {
  const secretKey = env.NANGO_SECRET_KEY?.trim();
  const host = env.NANGO_HOST?.trim();
  if (!secretKey) {
    if (host) throw new Error("NANGO_HOST requires NANGO_SECRET_KEY");
    return null;
  }
  return { host: origin(host || "https://api.nango.dev", "NANGO_HOST"), secretKey };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    nango: nango(env),
    databaseUrl: required(env, "DATABASE_URL"),
    relayControlUrl: origin(required(env, "RELAYCONTROL_URL"), "RELAYCONTROL_URL"),
    introspectSecret: secret(env, "RELAYCONTROL_INTROSPECT_SECRET"),
    audience: origin(required(env, "RELAYCHIEF_CONTROL_PUBLIC_ORIGIN"), "RELAYCHIEF_CONTROL_PUBLIC_ORIGIN"),
    adminToken: secret(env, "RELAYCHIEF_CONTROL_ADMIN_TOKEN"),
    browserOrigins: (env.RELAYCHIEF_CONTROL_BROWSER_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => origin(value, "RELAYCHIEF_CONTROL_BROWSER_ORIGINS")),
    host: env.HOST?.trim() || "0.0.0.0",
    port: port(env, "PORT", 3200),
    // Operator routes are unreachable from outside unless this is changed.
    adminHost: env.ADMIN_HOST?.trim() || "127.0.0.1",
    adminPort: port(env, "ADMIN_PORT", 3201),
  };
}
