#!/usr/bin/env bash
# Commits any uncommitted work and pushes everything to the private GitHub repo (origin/main). Run after every change:
#   bash scripts/backup-to-github.sh "short description of the change"
# Code only: .env*, backups/ and build output are ignored by .gitignore, and database backups are never committed.
set -euo pipefail
cd "$(dirname "$0")/.."
msg="${1:-update}"
# Refuse to continue if something that looks like a secret or a data backup is about to be committed.
if git ls-files --others --exclude-standard | grep -E '(^|/)\.env($|\.local|\.production)|^backups/|\.pem$|\.key$' >/dev/null; then echo "Refusing: a secret or backup file is not ignored." >&2; exit 1; fi
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "$msg

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
fi
git push -q origin main
echo "Pushed $(git rev-parse --short HEAD) to $(git remote get-url origin)"
