#!/usr/bin/env bash
# Rejects migrations that would break the previous release mid-rotation.
#
# Run locally. The same logic drives the "Migrations are expand/contract safe"
# step in .github/workflows/ci.yml.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
baseline_file="$repo/scripts/migration-baseline"
migrations="$repo/apps/api/prisma/migrations"

baseline_name="$(head -n 1 "$baseline_file" 2>/dev/null | tr -d '[:space:]')"
if [ -z "$baseline_name" ]; then
  echo "scripts/migration-baseline is missing or empty"
  exit 1
fi
if [ ! -d "$migrations/$baseline_name" ]; then
  echo "baseline '$baseline_name' is not a migration directory"
  exit 1
fi

reached=false
failed=0
for dir in "$migrations"/[0-9]*/; do
  name="$(basename "$dir")"
  if $reached; then
    file="$dir/migration.sql"
    [ -f "$file" ] || continue
    hits="$(grep -nE 'ALTER COLUMN "[^"]+" SET NOT NULL|DROP COLUMN|DROP INDEX|^UPDATE "' "$file" | grep -v 'expand-contract: approved' || true)"
    if [ -n "$hits" ]; then
      failed=1
      echo "  --- $name"
      echo "$hits"
    fi
  fi
  [ "$name" = "$baseline_name" ] && reached=true
done

if [ "$failed" -ne 0 ]; then
  echo "FAIL: a migration newer than $baseline_name uses SET NOT NULL, DROP COLUMN," \
       "DROP INDEX or a whole-table UPDATE."
  echo "The previous release is still serving when those run. Ship them as add," \
       "deploy the binary that writes it, then remove in a later release, or"
  echo "approve one in place with '-- expand-contract: approved: <reason>'."
  exit 1
fi

echo "PASS: no unsafe migrations after $baseline_name"
