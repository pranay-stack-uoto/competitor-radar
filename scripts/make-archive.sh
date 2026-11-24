#!/usr/bin/env bash
# Builds a clean source archive for sharing: no git history, no secrets, no internal reports, no build output, no backups.
# Usage: npm run archive [output.zip]      (default: ../radar-cloud-code.zip)
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-../radar-cloud-code.zip}"
rm -f "$out"
zip -qr "$out" . \
  -x "node_modules/*" ".next/*" ".git/*" ".vercel/*" ".env.local" ".env.*.local" ".env.production" ".env.development" \
     "backups/*" "*.radarbackup" "*.zip" "*.log" ".DS_Store" "Competitor-Radar-Build-Report.pdf" "build-report.html"
# Verify instead of trusting the exclusion list.
bad=$(unzip -Z1 "$out" | grep -E '^\.git/|(^|/)\.env($|\.local|\.production|\.development)|\.radarbackup$|\.vercel/|Build-Report|build-report|(^|/)node_modules/' || true)
if [ -n "$bad" ]; then echo "Archive contains files that must not be shared:" >&2; echo "$bad" >&2; rm -f "$out"; exit 1; fi
echo "Wrote $out ($(wc -c < "$out" | tr -d ' ') bytes, $(unzip -Z1 "$out" | wc -l | tr -d ' ') files). Contains .env.example only."
