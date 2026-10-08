import type { NetworkPolicyBuilder } from "microsandbox";
import { sdk } from "../msb/sdk.ts";

const ALLOWED_DOMAINS = [
  "repo.maven.apache.org",
  "repo1.maven.org",
  "maven.pkg.github.com",
  "github.com",
  "codeload.github.com",

  "nodejs.org",
  "registry.npmjs.org",

  "docker.io",
  "docker.com",

  "ghcr.io",
  "pkg-containers.githubusercontent.com",

  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
  "playwright.azureedge.net",

  "deb.debian.org",
  "security.debian.org",
  "mise.jdx.dev",
  "download.docker.com",
] as const;

const ALLOW_SUFFIXES = [
  ".githubusercontent.com",
  // The registry API lives on *.docker.io, but image BLOBS are redirected to a
  // CDN under docker.com -- production.cloudfront.docker.com (AWS) or
  // production.cloudflare.docker.com depending on the edge you land on.
  // Allowing only the cloudflare one makes every pull die with "lookup
  // production.cloudfront.docker.com ... no such host".
  ".docker.io",
  ".docker.com",
  // azureedge.net is Playwright's retired CDN, kept for older versions.
  ".azureedge.net",
] as const;

/**
 * What a SESSION may reach: Anthropic, and nothing else.
 *
 * Deliberately wider than Anthropic's own devcontainer firewall, which omits the
 * OAuth hosts -- without them `/login` and token refresh fail. Everything else
 * the session needs has to be in the named volume by the time `seu start` has
 * finished its install sandbox; there is no second chance in here.
 */
const SESSION_DOMAINS = [
  "api.anthropic.com", // inference, WebFetch safety check, feature flags
  "claude.ai", // claude.ai account authentication
  "claude.com", // sign-in redirect
  "platform.claude.com", // OAuth token exchange / refresh / revocation
  "downloads.claude.ai", // native installer, plugin downloads
] as const;

/**
 * Deny-by-default egress with the allowlist above; ingress untouched.
 */
export async function buildNetworkPolicy(): Promise<NetworkPolicyBuilder> {
  const { NetworkPolicy } = await sdk();
  return NetworkPolicy.builder()
    .defaultEgress("deny")
    .defaultIngress("allow")
    .egress((r) => r.allowDomains([...ALLOWED_DOMAINS]))
    .egress((r) => r.allowDomainSuffixes([...ALLOW_SUFFIXES]));
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
