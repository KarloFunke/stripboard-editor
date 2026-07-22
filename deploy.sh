#!/bin/bash
set -e

cd "$(dirname "$0")"

git pull

# Refresh nginx image
docker compose -p stripboard-editor pull --ignore-buildable

docker compose -p stripboard-editor build --pull

docker compose -p stripboard-editor up -d
docker compose -p stripboard-editor restart nginx

docker image prune -af
