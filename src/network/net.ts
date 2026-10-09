import type { NetworkPolicyBuilder } from "microsandbox";
import { sdk } from "../msb/sdk.ts";

/**
 * What a SESSION may reach: Anthropic, and nothing else.
 *
 * Deliberately wider than Anthropic's own devcontainer firewall, which omits the
 * OAuth hosts -- without them `/login` and token refresh fail. Everything else
 * the session needs has to be in the named volume by the time `seu start` has
 * finished its install sandbox; there is no second chance in here.
 */
export const SESSION_DOMAINS = [
  "api.anthropic.com", // inference, WebFetch safety check, feature flags
  "claude.ai", // claude.ai account authentication
  "claude.com", // sign-in redirect
  "platform.claude.com", // OAuth token exchange / refresh / revocation
  "downloads.claude.ai", // native installer, plugin downloads
] as const;

/**
 * What the throwaway install sandbox may reach: everything. What it needs
 * depends on the project -- the tools in its mise.toml, its Maven repositories,
 * its images -- so an allowlist would always be one project behind. The sandbox
 * is destroyed afterwards and the session never inherits this policy.
 */
export async function buildNetworkPolicy(): Promise<NetworkPolicyBuilder> {
  const { NetworkPolicy } = await sdk();
  return NetworkPolicy.builder()
    .defaultEgress("allow")
    .defaultIngress("allow");
}

/**
 * The narrowed policy the session runs under. Egress only: traffic that never
 * leaves the guest -- the docker bridge, published container ports on
 * localhost, Testcontainers -- is untouched, which is what lets the project's
 * own compose files and integration tests work under deny-all.
 *
 * Paired with strict mode and TLS interception at the sandbox (see
 * `createProjectSandbox`): without interception a hostname allow can be
 * domain-fronted, so the allowlist would be advisory rather than enforced.
 */
export async function sessionNetworkPolicy(): Promise<NetworkPolicyBuilder> {
  const { NetworkPolicy } = await sdk();
  return NetworkPolicy.builder()
    .defaultEgress("deny")
    .defaultIngress("allow")
    .egress((r) => r.allowDomains([...SESSION_DOMAINS]));
}
