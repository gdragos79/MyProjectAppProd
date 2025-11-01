#!/bin/sh
set -e

if [ -z "$APP_VM_CIDR" ]; then
  echo "APP_VM_CIDR not set; defaulting to 0.0.0.0/0 (NOT recommended for production)"
  APP_VM_CIDR="0.0.0.0/0"
fi

# Append a rule to pg_hba.conf allowing password auth from APP_VM_CIDR
echo "host all all ${APP_VM_CIDR} scram-sha-256" >> "$PGDATA/pg_hba.conf"

# Show what we appended (for logs)
tail -n 5 "$PGDATA/pg_hba.conf" || true
