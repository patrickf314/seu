#!/bin/bash
# The `seu build` warm-up. Runs as `seu` inside the BUILD sandbox, which is the
# only sandbox with wide network access. Everything it downloads must land under
# /seu -- the single named volume behind /work, ~/.m2, ~/.cache and dockerd's
# data-root -- because nothing else survives into the session sandbox.
#
# SEU_MVN_<ID>_USER / _PASS arrive through `msb exec -e` and stay in this
# process's environment. /tmp/seu-settings.xml reads them via ${env.*}, so no
# secret is ever written to disk inside the VM.
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
step "Installing the generated Maven settings"
# Written on the host by lib/maven-settings.py: the developer's repository
# configuration with ${env.*} credential placeholders, plus a file:///host-m2
# repository pointing at the host's ~/.m2/repository, which is mounted READ-ONLY
# into this sandbox. Maven resolves from it first and COPIES what it uses into
# ~/.m2/repository (that is, /seu/m2), so the session stays self-contained.
[[ -s /tmp/seu-settings.xml ]] || die "/tmp/seu-settings.xml is missing"
mkdir -p ~/.m2
cp /tmp/seu-settings.xml ~/.m2/settings.xml || die "could not install ~/.m2/settings.xml"
if [[ -d /host-m2 ]]; then
  printf '    reusing the host Maven repository at /host-m2 (read-only)\n' >&2
else
  printf '    no host Maven repository mounted; everything will be downloaded\n' >&2
fi

# ------------------------------------------------------------------- 3. docker
step "Waiting for dockerd"
for _ in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || die "dockerd is not reachable"

step "Pre-pulling external images"
# The list comes from `prepull` in the project's .seu/config.conf, handed over by
# `seu build` in SEU_PREPULL_IMAGES.
EXTERNAL_IMAGES="${SEU_PREPULL_IMAGES:-}"

# Anything the host already had was `docker save`d into one tar and mounted
# read-only at /host-images. Loading it turns most of the pull phase into a local
# copy. Only arm64/linux images are ever staged -- the host side refuses the
# rest, because an amd64 image here fails much later with "exec format error".
if [[ -f /host-images/images.tar ]]; then
  printf '    loading host images ... ' >&2
  if docker load -i /host-images/images.tar >/dev/null 2>&1; then
    echo ok >&2
  else
    echo FAILED >&2
    warn "could not load /host-images/images.tar; falling back to pulling everything"
  fi
fi

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
for img in $EXTERNAL_IMAGES; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    printf '    %s ... from host\n' "$img" >&2
  else
    pull_image "$img"
  fi
done
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

# ------------------------------------------------- 4b. explicitly-named artifacts
# `go-offline` only knows about plugins BOUND IN THE POM. A plugin invoked from
# the command line (`mvn failsafe:integration-test`, reported as `default-cli`)
# is invisible to it, and so is that plugin's dependency graph. `dependency:get`
# resolves the artifact properly -- descriptors, parent POMs and transitives --
# which a file copy cannot do.
if [[ -n "${SEU_WARM_ARTIFACTS:-}" ]]; then
  step "Resolving explicitly-named artifacts"
  for artifact in $SEU_WARM_ARTIFACTS; do
    printf '    %s ... ' "$artifact" >&2
    if mvn -B -q dependency:get -Dartifact="$artifact" >/dev/null 2>&1; then
      echo ok >&2
    else
      echo FAILED >&2
      warn "could not resolve $artifact -- it will be missing in the session"
    fi
  done
fi

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
# OS-level deps are already baked into the image; this fetches the BINARIES into
# ~/.cache/ms-playwright, which is a persistent volume.
#
# Browser binaries are per-platform, so the host's copies are no help -- they are
# macOS builds and this guest is linux-arm64. Whatever is not downloaded here is
# simply absent in the offline session, and the test that wants it dies with
# "ENOTFOUND cdn.playwright.dev" at test time. List every browser the suite uses
# in `playwright_browser`; chromium alone is the default and is often not enough.
if [[ -n "${SEU_PLAYWRIGHT_POM:-}" ]]; then
  step "Downloading Playwright browsers: ${SEU_PLAYWRIGHT_BROWSERS:-chromium}"
  mvn $MVN_FLAGS exec:java --file "$SEU_PLAYWRIGHT_POM" \
      -Dexec.mainClass=com.microsoft.playwright.CLI \
      -Dexec.args="install ${SEU_PLAYWRIGHT_BROWSERS:-chromium}" \
    || warn "Playwright browser download failed; UI tests will not run"

  # Verify rather than trust. This is the ONLY thing that installs browsers now
  # (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 disables the implicit install that
  # Playwright.create() would otherwise do), so a silent no-op here is a session
  # that cannot run UI tests at all.
  for browser in ${SEU_PLAYWRIGHT_BROWSERS:-chromium}; do
    if ls -d ~/.cache/ms-playwright/"${browser}"-* >/dev/null 2>&1; then
      printf '    %-12s ok\n' "$browser" >&2
    else
      warn "$browser is NOT in ~/.cache/ms-playwright; tests using it will fail offline"
    fi
  done
else
  step "Skipping Playwright (no playwright_pom in the project profile)"
fi

# --------------------------------------------------------- 8. app images (opt)
if [[ "$WITH_IMAGES" == "1" ]]; then
  step "Building tsv-neubiberg/* images (Paketo buildpacks)"
  mvn $MVN_FLAGS install -DskipTests \
    || warn "image build failed; test/docker-compose.yml will not come up"
else
  step "Skipping app images (pass --with-images to build them)"
fi

# ----------------------------------------------- 9. make the repository offline
step "Detaching the warmed repository from its remotes"
# Maven records where each artifact came from in `_remote.repositories`, and in
# OFFLINE mode it refuses an artifact whose recorded origin is not among the
# repositories currently in play -- "... has not been downloaded from it before".
# Half of this repository now says it came from `seu-host-m2`, a file:// URL that
# only exists inside the build sandbox. Dropping the tracking files makes Maven
# treat everything as locally installed, which is what the session needs.
find ~/.m2/repository \( -name _remote.repositories \
                      -o -name '*.lastUpdated' \
                      -o -name resolver-status.properties \
                      -o -name '*.part' -o -name '*.part.*' \) -delete 2>/dev/null

step "Removing the credentials and switching Maven offline"
# The credentials were only ever in this process's environment, but settings.xml
# still references them. Replace it with an offline-only settings file so session
# builds resolve purely from the warmed ~/.m2 and never attempt an authenticated
# fetch -- and so nothing points at /host-m2, which the session cannot see.
cat > ~/.m2/settings.xml <<'SETTINGS'
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 http://maven.apache.org/xsd/settings-1.0.0.xsd">
    <!-- Written by `seu build`. Credentials are deliberately NOT here: the
         session sandbox has no egress to any artifact repository anyway, and the
         host ~/.m2 it borrowed from is not mounted. Offline mode makes Maven
         resolve from the warmed local repository instead of failing slowly on
         unreachable remotes.
         Need a NEW dependency? Re-run `seu build` on the host. -->
    <offline>true</offline>
</settings>
SETTINGS

step "Warm-up complete"
df -h /seu 2>/dev/null | sed 's/^/    /' >&2
