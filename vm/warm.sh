#!/bin/bash
# The `seu build` warm-up. Runs as `seu` inside the BUILD sandbox, which is the
# only sandbox with wide network access. Everything it downloads must land in one
# of the four named volumes -- /work, ~/.m2, ~/.cache, /var/lib/docker -- because
# nothing else survives into the session sandbox.
#
# GITHUB_ACTOR / GITHUB_TOKEN arrive through `msb exec -e` and stay in this
# process's environment: .github/maven-settings.xml reads them via ${env.*}, so
# the PAT is never written to disk.
set -uo pipefail

step()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*" >&2; }
warn()  { printf '\033[33mwarn\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }

WITH_IMAGES="${SEU_WITH_IMAGES:-0}"
MVN_FLAGS="-B -T1C"

# ---------------------------------------------------------------------- 1. work
step "Preparing /work"
/usr/local/bin/session-init.sh || die "could not populate /work"
cd /work || die "/work missing"

# ------------------------------------------------------------------- 2. maven
step "Configuring Maven for GitHub Packages"
[[ -n "${GITHUB_TOKEN:-}" ]] || die "GITHUB_TOKEN is not set in the build environment"
mkdir -p ~/.m2
cp /work/.github/maven-settings.xml ~/.m2/settings.xml \
  || die "could not install ~/.m2/settings.xml"

# ------------------------------------------------------------------- 3. docker
step "Waiting for dockerd"
for _ in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || die "dockerd is not reachable"

step "Pre-pulling external images"
# Keep in sync with common/docker-compose.yml, test/docker-compose.yml and
# common/test-commons/.../container/*.java. The tsv-neubiberg/* images are built
# locally further down and are deliberately absent here.
EXTERNAL_IMAGES="
postgres:18
postgres:18-alpine
axllent/mailpit:v1.27
nextcloud:31.0.7
openobserve/openobserve:v1.0.0-rc3
nginx:latest
httpd:2.4.68-alpine
nickfedor/watchtower:latest
"
pull_image() {
  printf '    pulling %s ... ' "$1" >&2
  local out
  if out="$(docker pull -q "$1" 2>&1)"; then
    echo ok >&2
  else
    echo FAILED >&2
    # Surface the real reason -- a swallowed pull error here shows up much later
    # as an inscrutable jOOQ-codegen or Testcontainers failure.
    printf '%s\n' "$out" | tail -3 | sed 's/^/        /' >&2
    PULL_FAILURES=$((PULL_FAILURES + 1))
  fi
}

PULL_FAILURES=0
for img in $EXTERNAL_IMAGES; do pull_image "$img"; done
[[ $PULL_FAILURES -gt 0 ]] && die "$PULL_FAILURES image(s) could not be pulled -- \
    the session has no network, so anything missing now stays missing. \
    Check seu/config/net-build.yaml."

# ---------------------------------------------------------------- 4. the build
# `mvn install` needs Docker even with -DskipTests -DskipImages, because
# testcontainers-jooq-codegen-maven-plugin starts a postgres:18 container in
# generate-sources in every *-db-adapter module.
step "mvn install (dependencies, jOOQ codegen, node + pnpm install)"
mvn $MVN_FLAGS install -DskipTests -DskipImages \
  || die "mvn install failed -- the session would be unusable, fix this first"

step "mvn dependency:go-offline (test-scope and plugin artifacts)"
# `install` alone leaves behind artifacts that only failsafe/surefire resolve.
mvn $MVN_FLAGS dependency:go-offline -DskipNpmBuild=true \
  || warn "dependency:go-offline reported errors; some test runs may need a rebuild"

# --------------------------------------------------------- 5. surefire providers
step "Running the unit tests once"
# Not (only) a smoke test: surefire and failsafe resolve their PROVIDER jar at
# runtime -- `org.apache.maven.surefire:surefire-junit-platform` -- and neither
# `install` nor `dependency:go-offline` ever fetches it. Without this, the first
# `mvn test` in the offline session dies with
#   "Cannot access devx-repository ... in offline mode and the artifact
#    org.apache.maven.surefire:surefire-junit-platform:jar has not been
#    downloaded from it before".
# Actually running the tests is the self-maintaining way to cache every provider
# and test-scope artifact, and it proves Testcontainers works inside the VM.
#
# `install`, NOT `test`: a bare `mvn test` re-runs generate-sources without the
# upstream -api modules having been installed in that pass, so the de.devx
# react-client-api / assertj-assertion plugins abort with "No api models found".
# The full lifecycle is incremental here, so this costs about a minute.
# --fail-never: a failing test on the branch is not a reason to refuse a sandbox.
mvn $MVN_FLAGS install -DskipImages -DskipNpmBuild=true --fail-never 2>&1 \
  | grep -E "Tests run:|BUILD|FAILURE \[|Total time" | tail -30 >&2

# ------------------------------------------------------- 6. Testcontainers ryuk
step "Pre-pulling Testcontainers support images"
# Read the image refs out of the resolved testcontainers jar rather than pinning
# them here, so they always match the version the build actually uses.
TC_JAR="$(find ~/.m2/repository/org/testcontainers/testcontainers -name 'testcontainers-*.jar' \
            ! -name '*sources*' ! -name '*javadoc*' 2>/dev/null | sort | tail -1)"
if [[ -n "$TC_JAR" ]]; then
  for img in $(unzip -p "$TC_JAR" testcontainers.properties 2>/dev/null \
                 | sed -n 's/^[a-z.]*\.container\.image=//p'); do
    pull_image "$img"
  done
else
  warn "testcontainers jar not found; ryuk will be missing and integration tests will fail"
fi

# ------------------------------------------------------------- 7. Playwright
step "Downloading Playwright browsers"
# OS-level deps are already baked into the image; this fetches the binaries into
# ~/.cache/ms-playwright, which is a persistent volume.
mvn $MVN_FLAGS exec:java --file club/club-ui/club-ui-test/pom.xml \
    -Dexec.mainClass=com.microsoft.playwright.CLI \
    -Dexec.args="install chromium" \
  || warn "Playwright browser download failed; UI tests will not run"

# --------------------------------------------------------- 8. app images (opt)
if [[ "$WITH_IMAGES" == "1" ]]; then
  step "Building tsv-neubiberg/* images (Paketo buildpacks)"
  mvn $MVN_FLAGS install -DskipTests \
    || warn "image build failed; test/docker-compose.yml will not come up"
else
  step "Skipping app images (pass --with-images to build them)"
fi

# -------------------------------------------------------- 9. strip the secret
step "Removing the GitHub token and switching Maven offline"
# The PAT was only ever in this process's environment, but settings.xml still
# references it. Replace it with an offline-only settings file so session builds
# resolve purely from the warmed ~/.m2 and never attempt an authenticated fetch.
cat > ~/.m2/settings.xml <<'SETTINGS'
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 http://maven.apache.org/xsd/settings-1.0.0.xsd">
    <!-- Written by `seu build`. The GitHub PAT is deliberately NOT here: the
         session sandbox has no egress to GitHub Packages anyway. Offline mode
         makes Maven resolve from the warmed local repository instead of failing
         slowly on unreachable remotes.
         Need a NEW dependency? Re-run `seu build` on the host. -->
    <offline>true</offline>
</settings>
SETTINGS

step "Warm-up complete"
df -h /seu 2>/dev/null | sed 's/^/    /' >&2
