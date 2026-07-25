#!/usr/bin/env sh
set -eu

project_dir="${1:-/opt/lingxing-mcp}"
backup_dir="${2:-/opt/lingxing-mcp-backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
rm -f "$project_dir/deploy/data/access-backup.sqlite"
docker compose -f "$project_dir/deploy/compose.yaml" exec -T lingxing-mcp \
  node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/access.sqlite');d.exec(\"VACUUM INTO '/data/access-backup.sqlite'\");d.close()"
cp "$project_dir/deploy/data/access-backup.sqlite" "$backup_dir/access-$timestamp.sqlite"
chmod 600 "$backup_dir/access-$timestamp.sqlite"
rm -f "$project_dir/deploy/data/access-backup.sqlite"
find "$backup_dir" -type f -name 'access-*.sqlite' -mtime +30 -delete
printf '%s\n' "$backup_dir/access-$timestamp.sqlite"
