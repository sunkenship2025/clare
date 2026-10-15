#!/bin/sh
# One-time setup for your own clare. Run it from the repo root:
#
#   scripts/setup.sh          # create the free backend, publish site + downloads, open your dashboard
#   scripts/setup.sh login    # lost your dashboard link? get a fresh one
#   scripts/setup.sh deploy   # redeploy the backend after pulling changes
#
# Needs: node, git, gh (GitHub CLI), openssl, curl. Free accounts on Supabase and GitHub.
# Secrets it creates are kept in .clare-secret (git-ignored) on this computer only.

set -eu
cd "$(dirname "$0")/.."

SB="npx -y supabase@2.119.0"
STATE=".clare-secret"
export NODE_OPTIONS=""

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ask() { # ask "Question" default → prints answer
  printf '  %s ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  [ -n "$answer" ] || answer="${2:-}"
  printf '%s' "$answer"
}
need() { command -v "$1" >/dev/null 2>&1 || { echo "Please install $1 first: $2"; exit 1; }; }
save() { # save KEY VALUE into .clare-secret
  touch "$STATE" && chmod 600 "$STATE"
  grep -v "^$1=" "$STATE" > "$STATE.tmp" || true
  printf "%s='%s'\n" "$1" "$2" >> "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(($1)(j)??'')})"; }
open_url() { (command -v open >/dev/null && open "$1") || (command -v xdg-open >/dev/null && xdg-open "$1") || true; }

[ -f "$STATE" ] && . "./$STATE"

api_url() { printf 'https://%s.supabase.co/functions/v1/api' "$PROJECT_REF"; }

dashboard_link() {
  code=$(curl -fsS -X POST "$(api_url)/recover" -H 'content-type: application/json' \
    -d "{\"secret\":\"$SETUP_SECRET\"}" | json 'j=>j.login_code')
  web=$(node -p 'require("./clare.config.json").webUrl')
  link="$web/dash.html#login=$code"
  bold "Your dashboard (link works once, for 10 minutes):"
  info "$link"
  open_url "$link"
}

deploy_backend() {
  $SB db push --linked -p "$DB_PASSWORD"
  $SB secrets set "CLARE_SETUP_SECRET=$SETUP_SECRET" --project-ref "$PROJECT_REF"
  $SB functions deploy api --project-ref "$PROJECT_REF" --no-verify-jwt --use-api
}

case "${1:-setup}" in
  login) dashboard_link; exit 0 ;;
  deploy) deploy_backend; exit 0 ;;
  setup) ;;
  *) echo "usage: scripts/setup.sh [setup|login|deploy]"; exit 2 ;;
esac

need node "https://nodejs.org"
need gh "https://cli.github.com (Mac: brew install gh)"
need git "https://git-scm.com"
need openssl "it ships with macOS and Linux"
need curl "it ships with macOS and Linux"

bold "clare setup: about 5 minutes. You'll answer a few questions."

# ── 1. Supabase ───────────────────────────────────────────────
bold "1/4  Backend (Supabase, free)"
$SB projects list >/dev/null 2>&1 || $SB login

if [ -z "${PROJECT_REF:-}" ]; then
  ORG=$($SB orgs list -o json | json 'j=>(j[0]||{}).id')
  if [ -z "$ORG" ]; then
    info "Creating a free Supabase organization…"
    $SB orgs create "clare" >/dev/null
    ORG=$($SB orgs list -o json | json 'j=>(j[0]||{}).id')
  fi
  [ -n "$ORG" ] || { echo "Create a free Supabase organization at https://supabase.com/dashboard first, then re-run."; exit 1; }
  REGION=$(ask "Server region near you? Press Enter for Mumbai (ap-south-1), or type one like us-east-1, eu-west-1:" ap-south-1)
  REGION=$(printf '%s' "$REGION" | awk '{print $1}')
  DB_PASSWORD=$(openssl rand -hex 20)
  save DB_PASSWORD "$DB_PASSWORD"
  $SB projects create clare --org-id "$ORG" --db-password "$DB_PASSWORD" --region "$REGION"
  PROJECT_REF=$($SB projects list -o json | json 'j=>j.filter(p=>p.name==="clare").sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]?.id')
  [ -n "$PROJECT_REF" ] || { echo "Couldn't find the new project. Re-run scripts/setup.sh."; exit 1; }
  save PROJECT_REF "$PROJECT_REF"
fi
SETUP_SECRET=${SETUP_SECRET:-$(openssl rand -hex 24)}
save SETUP_SECRET "$SETUP_SECRET"

info "Waiting for the database to wake up…"
tries=0
until $SB link --project-ref "$PROJECT_REF" -p "$DB_PASSWORD" >/dev/null 2>&1; do
  tries=$((tries + 1)); [ $tries -lt 30 ] || { echo "Supabase project isn't ready yet. Re-run in a minute."; exit 1; }
  sleep 10
done
deploy_backend
curl -fsS "$(api_url)/health" >/dev/null && info "✓ backend is live at $(api_url)"

# ── 2. GitHub ─────────────────────────────────────────────────
bold "2/4  Website + downloads (GitHub, free)"
gh auth status >/dev/null 2>&1 || gh auth login
GH_USER=$(gh api user -q .login)
REPO=$(ask "GitHub repo name? [clare]" clare)
WEB="https://$GH_USER.github.io/$REPO"
EXT_URL=$(node -p 'try{require("./clare.config.json").extensionUrl||""}catch{""}')
cat > clare.config.json <<EOF
{
  "apiUrl": "$(api_url)",
  "webUrl": "$WEB",
  "releasesUrl": "https://github.com/$GH_USER/$REPO/releases/latest/download",
  "extensionUrl": "$EXT_URL"
}
EOF
git add -A
git commit -qm "Configure clare for $GH_USER" || true
if gh repo view "$GH_USER/$REPO" >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$GH_USER/$REPO.git"
  git push -qu origin HEAD:main
else
  # Public: GitHub Pages and release downloads need it (nothing secret is in the repo).
  gh repo create "$GH_USER/$REPO" --public --source . --remote origin --push
fi
gh api -X POST "repos/$GH_USER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 ||
  gh api -X PUT "repos/$GH_USER/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 || true

# ── 3. Build + publish ────────────────────────────────────────
bold "3/4  Building the downloads (about 3 minutes)…"
TAG="v$(node -p 'require("./package.json").version')"
git tag -f "$TAG" >/dev/null && git push -qf origin "$TAG"
sleep 8
RUN=$(gh run list -R "$GH_USER/$REPO" --workflow release.yml -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" -R "$GH_USER/$REPO" --exit-status >/dev/null || { echo "The build failed: gh run view $RUN -R $GH_USER/$REPO --log-failed"; exit 1; }
tries=0
until curl -fsS -o /dev/null "$WEB/dash.html"; do
  tries=$((tries + 1)); [ $tries -lt 30 ] || { echo "Website isn't up yet; run scripts/setup.sh login in a few minutes."; exit 1; }
  sleep 10
done
info "✓ website is live at $WEB"

# ── 4. You ────────────────────────────────────────────────────
bold "4/4  About you"
NEEDS=$(curl -fsS "$(api_url)/health" | json 'j=>j.needs_setup')
if [ "$NEEDS" = "true" ]; then
  NAME=$(ask "Your first name (shown on your dashboard)?" "$GH_USER")
  ACCOUNT=$(ask "A name for this Claude account? [My Claude]" "My Claude")
  PLAN=$(ask "Your Claude plan: pro, max5 or max20? [max5]" max5)
  curl -fsS -X POST "$(api_url)/setup" -H 'content-type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({secret:process.argv[1],owner_name:process.argv[2],account_name:process.argv[3],plan:process.argv[4]}))' "$SETUP_SECRET" "$NAME" "$ACCOUNT" "$PLAN")" >/dev/null
fi
dashboard_link
bold "Done! In the dashboard, click \"Add a device\" and open that link on each computer you use Claude on."
info "Lost the dashboard link later? Run: scripts/setup.sh login"
