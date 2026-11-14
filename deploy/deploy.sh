#!/usr/bin/env bash
# Deploys one release on the production instance. Run as root by SSM
# (the GitHub deploy workflow), or by hand in a Session Manager shell:
#
#   sudo bash /opt/dmarcharbor/deploy.sh <image-tag> <git-sha>
#
# 1. Fetches compose.prod.yaml and the Caddyfile for that commit.
# 2. Writes api.env, web.env and tunnel.env from SSM Parameter Store
#    (/dmarcharbor/prod/{api,web,tunnel}/NAME), readable by root only.
# 3. Pulls the images and recreates what changed. The API migrates on boot,
#    then the script waits for /api/ready before it reports success.
set -euo pipefail

tag="${1:?image tag}"
sha="${2:-$tag}"
repo="${DEPLOY_REPOSITORY:-toshifdotdev/dmarcharbor}"
dir=/opt/dmarcharbor
token="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
region="$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)"
account="$(aws sts get-caller-identity --query Account --output text --region "$region")"
registry="$account.dkr.ecr.$region.amazonaws.com"

cd "$dir"
umask 077

for file in compose.prod.yaml Caddyfile deploy.sh; do
  curl -fsSL "https://raw.githubusercontent.com/$repo/$sha/deploy/$file" -o "$file.new"
  mv "$file.new" "$file"
done

# KEY=VALUE per parameter, one file per container. Values are written as they
# are stored; compose reads env files literally (no quotes, no expansion).
write_env() {
  local group="$1" out="$2"
  aws ssm get-parameters-by-path --region "$region" --path "/dmarcharbor/prod/$group/" \
    --with-decryption --recursive --query 'Parameters[].[Name,Value]' --output json \
  | python3 -c '
import json, sys
rows = json.load(sys.stdin)
for name, value in sorted(rows):
    key = name.rsplit("/", 1)[-1]
    if "\n" in value:
        sys.exit(f"{key} holds a line break; env files cannot carry it")
    print(f"{key}={value}")
' > "$out.new"
  if [ ! -s "$out.new" ]; then
    echo "No parameters under /dmarcharbor/prod/$group/; refusing to deploy without them." >&2
    exit 1
  fi
  mv "$out.new" "$out"
}
write_env api api.env
write_env web web.env
write_env tunnel tunnel.env

# Hostnames Caddy sends straight to the API (deploy/Caddyfile).
read_param() { aws ssm get-parameter --region "$region" --name "/dmarcharbor/prod/deploy/$1" --query Parameter.Value --output text 2>/dev/null || true; }
cat > compose.env <<EOF
REGISTRY=$registry
IMAGE_TAG=$tag
AWS_REGION=$region
API_HOST=$(read_param API_HOST)
BIMI_HOST=$(read_param BIMI_HOST)
MTA_ORIGIN_HOST=$(read_param MTA_ORIGIN_HOST)
EOF

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry" >/dev/null

compose=(docker compose --env-file compose.env -f compose.prod.yaml)
"${compose[@]}" pull --quiet
"${compose[@]}" up -d --remove-orphans

# Ready means migrated, connected to the database and serving.
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T api wget -q -O /dev/null http://127.0.0.1:4000/api/ready 2>/dev/null \
    && "${compose[@]}" exec -T web wget -q -O /dev/null http://127.0.0.1:3000/robots.txt 2>/dev/null; then
    echo "Release $tag is ready."
    echo "$tag" > current-release
    docker image prune -af --filter "until=168h" >/dev/null || true
    exit 0
  fi
  sleep 5
done

echo "Release $tag did not become ready in 5 minutes." >&2
"${compose[@]}" ps >&2 || true
"${compose[@]}" logs --tail 80 api web >&2 || true
exit 1
