import { z } from "zod";
import { ChiefError } from "../chief/registry.js";

const activeSchema = z.looseObject({
  active: z.literal(true),
  principal_type: z.string(),
  org: z.string().min(1),
  workspace: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).optional(),
});
const resultSchema = z.union([
  activeSchema,
  z.looseObject({ active: z.literal(false), reason: z.string() }),
]);

export type Introspection = z.infer<typeof resultSchema>;
export type Introspector = (token: string, workspaceId: string) => Promise<Introspection>;

/** Asks relay-control about a caller's token. There is no cache and no offline path. */
export function relayControlIntrospector(options: {
  relayControlUrl: string;
  secret: string;
  audience: string;
  fetch?: typeof fetch;
}): Introspector {
  const fetcher = options.fetch ?? fetch;
  const endpoint = new URL("/internal/v1/auth/introspect", options.relayControlUrl);
  return async (token, workspaceId) => {
    const unavailable = () => new ChiefError(503, "identity_unavailable", "Sign-in could not be checked.");
    let body: unknown;
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${options.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ token, aud: options.audience, workspace: workspaceId }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw unavailable();
      body = await response.json();
    } catch {
      throw unavailable();
    }
    const parsed = resultSchema.safeParse(body);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  };
}
