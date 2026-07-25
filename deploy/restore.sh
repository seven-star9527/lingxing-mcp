#!/usr/bin/env sh
set -eu

backup_file="${1:?用法: restore.sh /path/to/access-backup.sqlite [/opt/lingxing-mcp]}"
project_dir="${2:-/opt/lingxing-mcp}"

test -f "$backup_file"
backup_dir="$(cd "$(dirname "$backup_file")" && pwd)"
backup_name="$(basename "$backup_file")"
data_dir="$project_dir/deploy/data"
database_file="$data_dir/access.sqlite"
restore_file="$data_dir/access.sqlite.restore"
rollback_file="$data_dir/access.sqlite.pre-restore"

wait_healthy() {
  attempts=0
  while test "$attempts" -lt 30; do
    container_id="$(docker compose -f "$project_dir/deploy/compose.yaml" ps -q lingxing-mcp)"
    if test -n "$container_id"; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
      test "$health" = "healthy" && return 0
      test "$health" = "unhealthy" && return 1
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  return 1
}

check_result="$(docker compose -f "$project_dir/deploy/compose.yaml" run --rm \
  -v "$backup_dir:/restore-source:ro" \
  lingxing-mcp node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/restore-source/$backup_name', { readOnly: true });
    const result = db.prepare('PRAGMA quick_check').get();
    db.close();
    process.stdout.write(String(result.quick_check));
  ")"
test "$check_result" = "ok"

docker compose -f "$project_dir/deploy/compose.yaml" stop lingxing-mcp
rm -f "$restore_file"
if test -f "$database_file"; then
  cp -p "$database_file" "$rollback_file"
fi
rm -f "$data_dir/access.sqlite-wal" "$data_dir/access.sqlite-shm"
cp "$backup_file" "$restore_file"
chmod 600 "$restore_file"
chown 1000:1000 "$restore_file"
mv "$restore_file" "$database_file"

if ! docker compose -f "$project_dir/deploy/compose.yaml" up -d lingxing-mcp || ! wait_healthy; then
  docker compose -f "$project_dir/deploy/compose.yaml" stop lingxing-mcp
  rm -f "$data_dir/access.sqlite-wal" "$data_dir/access.sqlite-shm"
  if test -f "$rollback_file"; then
    mv "$rollback_file" "$database_file"
    chown 1000:1000 "$database_file"
    docker compose -f "$project_dir/deploy/compose.yaml" up -d lingxing-mcp
    wait_healthy
  fi
  exit 1
fi
rm -f "$rollback_file"
