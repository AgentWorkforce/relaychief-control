import { z } from "zod";
import { open, seal, type SecretKey } from "../crypto.js";
import { ChiefError, type RelayAgentIssuer, type TokenCipher } from "./registry.js";

const answerSchema = z.object({
  agentId: z.string().min(1).max(500),
  token: z.string().min(1).max(4096),
  relayWorkspaceId: z.string().min(1).max(500),
});

export function secretCipher(key: SecretKey): TokenCipher {
  return { seal: (value) => seal(value, key), open: (sealed) => open(sealed, key) };
}

function unavailable(): ChiefError {
  return new ChiefError(503, "relay_identity_unavailable", "Relay agent registration is unavailable.");
}

/** relay-control holds the workspace Relaycast key and registers the agent; this service never sees that key. */
export function relayControlAgentIssuer(config: { relayControlUrl: string; secret: string }): RelayAgentIssuer {
  return {
    async issue(workspaceId, chiefId) {
      let response: Response;
      try {
        response = await fetch(new URL(`/internal/v1/chief/workspaces/${encodeURIComponent(workspaceId)}/relay-agents`, config.relayControlUrl), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { accept: "application/json", authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ chiefId }),
        });
      } catch {
        throw unavailable();
      }
      if (response.status === 409) {
        await response.body?.cancel().catch(() => {});
        throw new ChiefError(409, "relay_agent_conflict", "That agent name is taken by another agent.");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const answer = answerSchema.safeParse(await response.json().catch(() => null));
      if (!answer.success) throw unavailable();
      return answer.data;
    },
  };
}
