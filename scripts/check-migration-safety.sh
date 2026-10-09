# Mirrors the shell in .github/workflows/ci.yml ("Migrations are expand/contract
# safe"). Kept here so the logic can be run locally rather than only in CI.
set -u
cd "$(dirname "$0")/../apps/api/prisma/migrations"

marker="$(ls -d [0-9]*_expand_contract_baseline 2>/dev/null | head -n 1 || true)"
if [ -z "$marker" ]; then
  echo "no expand_contract_baseline marker"
  exit 1
fi

offenders=""
reached_marker=false
for dir in [0-9]*/; do
  # `ls -d` returns no trailing slash, the glob does, so compare stripped.
  if $reached_marker; then
    file="${dir%/}/migration.sql"
    [ -f "$file" ] || continue
    hits="$(grep -nE 'ALTER COLUMN "[^"]+" SET NOT NULL|DROP COLUMN|DROP INDEX|^UPDATE "' "$file" | grep -v 'expand-contract: approved' || true)"
    if [ -n "$hits" ]; then
      offenders="$offenders
${dir%/}:
$hits"
    fi
  fi
  [ "${dir%/}" = "$marker" ] && reached_marker=true
done

if [ -n "$offenders" ]; then
  echo "$offenders"
  echo "FAIL: unsafe migration after the baseline"
  exit 1
fi
echo "PASS: no unsafe migrations after the baseline"
