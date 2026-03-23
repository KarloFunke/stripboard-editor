#!/bin/bash
set -e

cd "$(dirname "$0")"

git pull
docker compose -p stripboard-editor build
docker compose -p stripboard-editor up -d
docker compose -p stripboard-editor restart nginx
