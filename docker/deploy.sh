#!/usr/bin/env bash
# Builds the Ocean Assistant image and runs it, locally or on a server over SSH.
#
#   docker/deploy.sh                                   build and run on this machine
#                                                      (http://localhost:3130/ocean-ai)
#   DEPLOY_HOST=divesha@opmthredds.gem.spc.int docker/deploy.sh
#                                                      build here, copy the image over SSH, run it there;
#                                                      nginx serves it at https://opmthredds.gem.spc.int/ocean-ai
#                                                      (location block: docker/nginx-ocean-ai.conf)
#
# The server needs Docker, and the SSH user must be allowed to run docker.
# Nothing is pushed to a registry; the image is streamed over SSH.
#
# Options (environment variables):
#   DEPLOY_HOST   SSH target; unset deploys to this machine
#   PORT          host port for the app (default 3130; must match proxy_pass in the nginx config)
#   BIND          host address to listen on (default 127.0.0.1, so only nginx can reach it)
#   PLATFORM      image platform (default linux/amd64 for a server, this machine's for local)
#   NEXT_PUBLIC_CESIUM_ION_TOKEN   defaults to the value in .env.local
#
# Serve it over HTTPS for anyone but yourself: browsers only allow WebGPU, multi-threaded
# wllama (SharedArrayBuffer) and the model cache (OPFS) on secure origins, and plain http
# counts as secure on localhost only.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME=ocean-assistant
BASE_PATH=/ocean-ai # basePath in next.config.ts
HOST="${DEPLOY_HOST:-}"
PORT="${PORT:-3130}"
BIND="${BIND:-127.0.0.1}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Runs a command here, or on DEPLOY_HOST with its arguments quoted for the remote shell.
on_target() {
  if [[ -n "$HOST" ]]; then ssh "$HOST" "$(printf '%q ' "$@")"; else "$@"; fi
}

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon isn't running"
if [[ -n "$HOST" ]]; then
  PLATFORM="${PLATFORM:-linux/amd64}"
  ssh "$HOST" docker info >/dev/null 2>&1 || die "can't run docker on $HOST over SSH"
fi

# Fail before the build if something else already listens on PORT (our own container is fine).
if on_target sh -c "ss -ltnH 2>/dev/null | awk '{print \$4}' | grep -qE '[:.]$PORT\$' || lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1"; then
  on_target docker port "$NAME" 2>/dev/null | grep -qE "[:.]$PORT\$" ||
    die "port $PORT is already in use on ${HOST:-this machine}; pick a free one with PORT=..."
fi

if [[ -z "${NEXT_PUBLIC_CESIUM_ION_TOKEN:-}" && -f .env.local ]]; then
  NEXT_PUBLIC_CESIUM_ION_TOKEN="$(sed -n 's/^NEXT_PUBLIC_CESIUM_ION_TOKEN=//p' .env.local | tail -1)"
fi
[[ -n "${NEXT_PUBLIC_CESIUM_ION_TOKEN:-}" ]] || log "Warning: no NEXT_PUBLIC_CESIUM_ION_TOKEN; Cesium ion imagery won't load"

# Tag with the commit, so each deploy is identifiable and the previous image stays for rollback.
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
git diff --quiet HEAD 2>/dev/null || TAG="$TAG-dirty-$(date +%Y%m%d%H%M%S)"
IMAGE="$NAME:$TAG"

log "Building $IMAGE${PLATFORM:+ for $PLATFORM}"
docker build \
  -f docker/Dockerfile \
  ${PLATFORM:+--platform "$PLATFORM"} \
  --build-arg NEXT_PUBLIC_CESIUM_ION_TOKEN="${NEXT_PUBLIC_CESIUM_ION_TOKEN:-}" \
  -t "$IMAGE" -t "$NAME:latest" \
  .

if [[ -n "$HOST" ]]; then
  log "Copying the image to $HOST"
  docker save "$IMAGE" | gzip | ssh "$HOST" "gunzip | docker load"
  on_target docker tag "$IMAGE" "$NAME:latest"
fi

log "Starting $NAME${HOST:+ on $HOST} at $BIND:$PORT"
on_target docker rm -f "$NAME" >/dev/null 2>&1 || true
on_target docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "$BIND:$PORT:3000" \
  "$IMAGE" >/dev/null

log "Waiting for the health check"
status=starting
for _ in $(seq 1 30); do
  status="$(on_target docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
  [[ "$status" == starting ]] || break
  sleep 2
done
if [[ "$status" != healthy ]]; then
  on_target docker logs --tail 50 "$NAME" || true
  die "$NAME is $status"
fi

# Keep the current and previous images for rollback; drop older ones.
on_target sh -c "docker images '$NAME' --format '{{.Tag}}' | grep -v '^latest\$' | tail -n +3 | xargs -r -I{} docker rmi '$NAME:{}'" >/dev/null 2>&1 || true

log "Deployed $IMAGE on ${HOST:-this machine}: http://$BIND:$PORT$BASE_PATH"
[[ -n "$HOST" ]] && log "Public URL (once the nginx location is in place): https://${HOST#*@}$BASE_PATH"
exit 0
