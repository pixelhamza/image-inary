#!/usr/bin/env bash
# Deploys Imageinary onto the EC2 host provisioned by provision-aws.sh:
# installs Docker, uploads the app source, migrates the RDS database,
# writes .env, and brings the stack up with docker compose.
#
# Usage: ./infra/deploy-app.sh you@example.com
set -euo pipefail
export AWS_PAGER=""

ACME_EMAIL="${1:?Usage: deploy-app.sh <acme-contact-email>}"

# Must match the CONFIG block in provision-aws.sh — these two were never
# persisted to state.env because they're static inputs, not generated IDs.
DB_NAME="imageinary"
DB_MASTER_USERNAME="imageinary_admin"
APP_DB_USER="imageinary_app"
AWS_PROFILE="imageinary"
AWS_REGION="$(aws configure get region --profile "$AWS_PROFILE")"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/.." && pwd)"
GEN_DIR="$HERE/.generated"
STATE_FILE="$GEN_DIR/state.env"
[[ -f "$STATE_FILE" ]] || { echo "Run provision-aws.sh first." >&2; exit 1; }
# shellcheck disable=SC1090
source "$STATE_FILE"

SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
REMOTE="ubuntu@${EIP_ADDRESS}"
ssh_() { ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

echo "Waiting for SSH on $EIP_ADDRESS..."
for _ in $(seq 1 30); do
  ssh_ true 2>/dev/null && break
  sleep 5
done
ssh_ true

echo "Installing Docker and tools on the host (idempotent)..."
ssh_ 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
if [[ ! -f /swapfile ]]; then
  # t3.micro has only 1GiB RAM; a 2GiB swapfile keeps docker compose build
  # from getting OOM-killed on the Go/Node build stages.
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg postgresql-client python3
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p ~/imageinary ~/.local/share/imageinary
curl --fail --silent --show-error \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o ~/.local/share/imageinary/rds-global-bundle.pem
chmod 644 ~/.local/share/imageinary/rds-global-bundle.pem
REMOTE_SCRIPT

echo "Packaging and uploading application source..."
# PROJECT_ROOT must mirror what infra/compose.yaml expects: backend/ (Go
# service), frontend/, infra/, database/ as siblings.
TAR_PATH="$GEN_DIR/imageinary-src.tar"
tar -cf "$TAR_PATH" -C "$PROJECT_ROOT" \
  --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='bin' \
  --exclude='.generated' --exclude='.env' --exclude='*.pem' \
  --exclude='test-results' --exclude='playwright-report' --exclude='coverage' \
  backend database frontend infra
scp_ "$TAR_PATH" "$REMOTE:~/imageinary-src.tar"
rm -f "$TAR_PATH"
ssh_ 'rm -rf ~/imageinary && mkdir -p ~/imageinary && tar -xf ~/imageinary-src.tar -C ~/imageinary && rm ~/imageinary-src.tar'

echo "Preparing secrets (never printed)..."
if ! grep -q '^APP_DB_PASSWORD=' "$STATE_FILE" 2>/dev/null; then
  echo "APP_DB_PASSWORD=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24)" >> "$STATE_FILE"
fi
if ! grep -q '^DEMO_API_TOKEN=' "$STATE_FILE" 2>/dev/null; then
  echo "DEMO_API_TOKEN=$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 48)" >> "$STATE_FILE"
fi
# shellcheck disable=SC1090
source "$STATE_FILE"

SECRETS_FILE="$GEN_DIR/remote-secrets.env"
cat > "$SECRETS_FILE" <<EOF
PGHOST=$DB_ENDPOINT
PGUSER=$DB_MASTER_USERNAME
PGPASSWORD=$DB_MASTER_PASSWORD
APP_DB_USER=$APP_DB_USER
APP_DB_PASSWORD=$APP_DB_PASSWORD
DB_NAME=$DB_NAME
DEMO_API_TOKEN=$DEMO_API_TOKEN
S3_BUCKET=$BUCKET_NAME
AWS_REGION_VALUE=$AWS_REGION
DOMAIN=$SSLIP_HOST
ACME_EMAIL=$ACME_EMAIL
EOF
chmod 600 "$SECRETS_FILE"
scp_ "$SECRETS_FILE" "$REMOTE:~/.imageinary-secrets.env"
rm -f "$SECRETS_FILE"
ssh_ 'chmod 600 ~/.imageinary-secrets.env'

echo "Running database migration and writing .env on the host..."
ssh_ 'bash -s' <<'REMOTE_SCRIPT2'
set -euo pipefail
set -a
source ~/.imageinary-secrets.env
set +a
export PGSSLMODE=verify-full
export PGSSLROOTCERT=$HOME/.local/share/imageinary/rds-global-bundle.pem

PGDATABASE=postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$APP_DB_USER') THEN
    CREATE ROLE $APP_DB_USER LOGIN PASSWORD '$APP_DB_PASSWORD';
  ELSE
    ALTER ROLE $APP_DB_USER WITH PASSWORD '$APP_DB_PASSWORD';
  END IF;
END
\$\$;
SQL

PGDATABASE="$DB_NAME" psql -v ON_ERROR_STOP=1 -f ~/imageinary/database/001_init.sql
PGDATABASE="$DB_NAME" psql -v ON_ERROR_STOP=1 <<SQL
GRANT CONNECT ON DATABASE $DB_NAME TO $APP_DB_USER;
GRANT USAGE ON SCHEMA public TO $APP_DB_USER;
GRANT SELECT, INSERT ON TABLE vaults TO $APP_DB_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE media TO $APP_DB_USER;
SQL

cd ~/imageinary
if [[ -f .env ]]; then
  echo ".env already exists on host — leaving it as-is."
else
  cat > .env <<ENVEOF
DATABASE_URL=postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@${PGHOST}:5432/${DB_NAME}?sslmode=verify-full&sslrootcert=/etc/ssl/certs/aws-rds-ca.pem
DEMO_API_TOKEN=${DEMO_API_TOKEN}
S3_BUCKET=${S3_BUCKET}
AWS_REGION=${AWS_REGION_VALUE}
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
RDS_CA_BUNDLE=$HOME/.local/share/imageinary/rds-global-bundle.pem
ENVEOF
  chmod 600 .env
  echo "Wrote ~/imageinary/.env"
fi
rm -f ~/.imageinary-secrets.env
REMOTE_SCRIPT2

echo "Building and starting the stack (this can take several minutes)..."
ssh_ 'cd ~/imageinary && sudo docker compose --env-file .env -f infra/compose.yaml config --quiet'
ssh_ 'cd ~/imageinary && sudo docker compose --env-file .env -f infra/compose.yaml build'
ssh_ 'cd ~/imageinary && sudo docker compose --env-file .env -f infra/compose.yaml run --rm --no-deps web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh_ 'cd ~/imageinary && sudo docker compose --env-file .env -f infra/compose.yaml up -d'
ssh_ 'cd ~/imageinary && sudo docker compose --env-file .env -f infra/compose.yaml ps'

echo
echo "================================ DEPLOYED ================================"
echo "Site:    https://$SSLIP_HOST"
echo "Demo API credential: see $STATE_FILE (DEMO_API_TOKEN) — not printed"
echo "It can take a minute for Caddy to obtain its first Let's Encrypt cert."
echo "Check: curl --fail https://$SSLIP_HOST/healthz && curl --fail https://$SSLIP_HOST/readyz"
