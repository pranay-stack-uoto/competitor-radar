#!/usr/bin/env bash
# Publishes a clean SNAPSHOT of the code to the PUBLIC repository (github.com/pranay-stack-uoto/competitor-radar). Run only when you want the public copy updated:
#   bash scripts/publish-public.sh
# It never touches the private backup repository and never publishes history: it builds one fresh commit from the tracked files only, so commit
# authors, early drafts and anything that was ever in the private history stay private. Left out on purpose (internal or security-sensitive):
#   .env* and backups/ (not tracked anyway), CLAUDE.md, the backup workflow, and these docs: BASELINE, DEFENSIBILITY, INCIDENT_RESPONSE, OPERATIONS,
#   SECURITY, TECHNICAL_DEBT, ENVIRONMENTS (they describe weaknesses, operations and production setup).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="https://github.com/pranay-stack-uoto/competitor-radar.git"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

git ls-files -z | while IFS= read -r -d '' f; do
  case "$f" in
    CLAUDE.md|.github/workflows/backup.yml|docs/BASELINE.md|docs/DEFENSIBILITY.md|docs/INCIDENT_RESPONSE.md|docs/OPERATIONS.md|docs/SECURITY.md|docs/TECHNICAL_DEBT.md|docs/ENVIRONMENTS.md|README.md) continue ;;
    .env*|*/.env*|backups/*|*.pem|*.key) continue ;;
  esac
  mkdir -p "$OUT/$(dirname "$f")"; cp -p "$f" "$OUT/$f"
done

cp scripts/public-README.md "$OUT/README.md"
cp scripts/public-LICENSE.txt "$OUT/LICENSE"

# Last check on the exact files about to be published: no key-looking strings, no private-key blocks, no env files.
if grep -rIlE 'AIza[0-9A-Za-z_-]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|gh[po]_[A-Za-z0-9]{20,}|eyJhbGci[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC )?PRIVATE KEY' "$OUT" >/dev/null 2>&1; then echo "Refusing: something that looks like a secret is in the snapshot." >&2; exit 1; fi
if find "$OUT" -name '.env*' ! -name '.env.example' | grep -q .; then echo "Refusing: an env file is in the snapshot." >&2; exit 1; fi

cd "$OUT"
git init -q -b main
git config user.name "Pranay Sheth"
git config user.email "273521503+pranay-stack-uoto@users.noreply.github.com"
git add -A
git commit -q -m "Competitor Radar: source snapshot $(date -u +%Y-%m-%d)"
git push -q --force "$REPO" main
echo "Published $(git rev-parse --short HEAD) to $REPO"
