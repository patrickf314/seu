import type { NetworkPolicyBuilder } from "microsandbox";
import { sdk } from "../microsandbox/microsandboxSdk.ts";

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
