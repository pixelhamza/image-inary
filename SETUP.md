# Imageinary: end-to-end setup and deployment

**Verification status:** both Docker images build, the production Caddy configuration validates, and a local browser/container check passes through the compiled React frontend → Caddy → Go → PostgreSQL for vault creation and reload/unlock. The local container check uses localhost and intentionally unconfigured S3, which fails closed. Real AWS provisioning, trusted public HTTPS, private RDS connectivity, S3 privacy/IAM, and actual browser S3 CORS transfers still require the operator's deployment and verification below. Nothing has been deployed to AWS by this guide's authoring process.

## 1. What runs where

| Part | Location | Purpose |
|---|---|---|
| React + Web Crypto | Your browser | Vault creation/unlock; photo validation; encryption/decryption; previews and downloads. |
| Caddy + compiled React files | `web` Docker container on EC2 | Public HTTPS, automatic TLS certificate, static frontend, `/api/*` reverse proxy. |
| Go + Chi API | `backend` Docker container on the same EC2 instance | Demo access control, encrypted metadata, narrowly scoped presigned URLs, upload verification, deletion. No public backend port. |
| PostgreSQL | Private RDS PostgreSQL instance | Public vault salt/KDF configuration, encrypted verifier, wrapped photo keys, encrypted metadata, random object IDs, operational sizes/timestamps. |
| Ciphertext objects | Private S3 bucket | Encrypted originals and separately encrypted thumbnails under `ciphertext/<UUIDv4>`. |
| IAM credentials | EC2 instance role | Go obtains temporary AWS credentials through the SDK. Do not put AWS access keys in the app. |
| Optional metrics | CloudWatch agent on EC2 | Basic host memory/disk metrics using `infra/cloudwatch-agent.example.json`. |

```text
Browser --HTTPS--> EC2:443 / Caddy --private Docker network--> Go:8080
   |                                                        |
   | ciphertext PUT/GET using temporary presigned URLs       +--> private RDS:5432, verified TLS
   +----------------HTTPS----------------> private S3        +--> S3 signing, HEAD, delete via IAM role
```

The browser never sends the vault passphrase, unwrapped keys, original photo bytes, or plaintext thumbnails/filenames to Go, RDS, or S3. The separate **demo API credential** does go to the API over HTTPS. This is not production authentication or an audited production vault.

Supported files: PNG, JPG/JPEG, GIF. Originals are not re-encoded; animated GIF bytes are preserved. Maximum original size: 20 MiB; local selection: 12 photos / 100 MiB. The lab gallery lists up to 100 ready records.

## 2. Understand the two secrets

1. **Demo API credential:** operator-controlled, high-entropy, 32–256 printable ASCII characters without spaces. Configure it as `DEMO_API_TOKEN` on the backend and enter the same value in the browser's **Demo API credential** field. Generate/store it using a password manager. It is not an AWS key.
2. **Vault passphrase:** chosen in the browser when creating the vault; at least 12 characters, preferably a much stronger unique passphrase. Do not put it in `.env`, shell commands, server configuration, or this guide. Keep it safe: there is no recovery or passphrase-change feature.

After a page reload or on another browser, enter the operator credential, connect to the API, then enter the original vault passphrase. Salt and wrapped keys come from RDS; neither secret is saved in localStorage/sessionStorage by the app. Use **Lock & disconnect** when finished.

## 3. Local development on Windows

### Prerequisites

- Node.js 22.19+ (or a compatible current Node 22 release), npm, Go 1.25+, Git.
- Docker Desktop running in Linux-container mode if using the local PostgreSQL command below.
- `psql` PostgreSQL client, or an existing PostgreSQL installation.
- Chrome/Edge, or Playwright's installed Chromium for browser tests.

Run commands from the repository root unless a different directory is shown. The Go process **does not automatically load `.env`**; set its process environment explicitly. Never paste real secrets into a chat or commit them.

### Local PostgreSQL (optional Docker instance)

Use an unused host port. These commands create a development-only database and persistent Docker volume on your computer, not AWS resources:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$env:POSTGRES_PASSWORD = [Convert]::ToBase64String($bytes)
$rng.Dispose()
[Array]::Clear($bytes, 0, $bytes.Length)

docker run --name imageinary-postgres -d `
  -p 127.0.0.1:5432:5432 `
  --env POSTGRES_PASSWORD `
  -e POSTGRES_USER=imageinary -e POSTGRES_DB=imageinary `
  --mount source=imageinary-pgdata,target=/var/lib/postgresql/data `
  postgres:16-alpine

# Wait until this reports that PostgreSQL is accepting connections.
docker exec imageinary-postgres pg_isready -h 127.0.0.1 -U imageinary -d imageinary

$env:PGPASSWORD = $env:POSTGRES_PASSWORD
psql -h 127.0.0.1 -p 5432 -U imageinary -d imageinary -v ON_ERROR_STOP=1 -f database/001_init.sql
Remove-Item Env:PGPASSWORD

$encodedPassword = [uri]::EscapeDataString($env:POSTGRES_PASSWORD)
$env:DATABASE_URL = "postgres://imageinary:$encodedPassword@127.0.0.1:5432/imageinary?sslmode=disable"
```

Keep the generated development password in a password manager if you intend to reuse this database. The named volume retains its original password across container restarts; generating another environment password does not change an existing database password. Do not remove an existing container or volume containing wanted data. Use another name/port or reuse its existing credentials instead.

### Start Go (terminal 1)

Continue in the same PowerShell process so the local `DATABASE_URL` is retained:

```powershell
$secureToken = Read-Host 'Enter the demo API credential from your password manager' -AsSecureString
$env:DEMO_API_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
$env:APP_ENV = 'development'
$env:HOST = 'localhost'
$env:PORT = '8080'

# Leave BOTH empty for API/database-only development.
$env:S3_BUCKET = ''
$env:AWS_REGION = ''

Set-Location backend
go mod download
go run ./cmd/server
```

With no S3 configuration, vault create/read and empty gallery listing work, but upload/download-signing/delete operations correctly return 503. The normal local app does **not** include a fake S3 service. Browser test fixtures are test-only and must not be presented as real cloud storage.

For actual S3 transfers during development, first authorize/configure a real private bucket, its IAM access, and exact-origin CORS as described below. Set both `S3_BUCKET` and `AWS_REGION`; use your authorized SDK credential provider/profile locally. On EC2, use the instance role. Never add AWS credentials to frontend configuration.

### Start React (terminal 2)

```powershell
Set-Location frontend
npm ci
npm run dev
```

Open **http://localhost:5173**, not a LAN IP. Vite proxies `/api` and `/healthz` to `localhost:8080`. Check:

```powershell
curl.exe -f http://localhost:8080/healthz
curl.exe -f http://localhost:8080/readyz
```

`/healthz` is API liveness. `/readyz` checks database connectivity and required tables; it is **not** proof of working S3, IAM, CORS, or HTTPS deployment. Apply the SQL migration before expecting database readiness.

## 4. AWS prerequisites and budget gate

The following is an operator checklist, **not authorization for an agent to create resources**. Choose one region, check the college/lab account restrictions and remaining credits, and approve any billable provisioning separately.

- Set AWS Budget/billing alerts. Credits are not a spending cap.
- Use one small Linux EC2 instance and one small **Single-AZ** PostgreSQL RDS instance permitted by the account. Allow sufficient RAM for Docker image builds; a 1 GiB instance may run out during builds. Check regional pricing instead of assuming all resources are free.
- No ALB, NAT gateway, Kubernetes, Redis, Terraform, Cognito, or additional services are required.
- Public IPv4 addresses, EC2/EBS, RDS storage/backups, S3 requests/storage, snapshots, and CloudWatch can incur charges. Plan cleanup before the demo.

### VPC and security groups

1. EC2 and RDS must be in the same VPC, with working local routing.
2. EC2 is in a public subnet with an internet gateway and outbound HTTPS access for S3, image/package downloads, and TLS issuance. A NAT gateway is unnecessary for this layout.
3. RDS uses a DB subnet group covering the required subnets in at least two AZs, but the **DB instance remains Single-AZ**. Keep **Public access: No**.
4. EC2 security group inbound:
   - TCP 80 and 443 for public HTTP redirect/TLS issuance and HTTPS.
   - TCP 22 only from the operator's current trusted IP if SSH is used.
   - Do **not** expose 8080 or PostgreSQL to the internet.
5. RDS security group inbound: TCP 5432 **from the EC2 security group only**. Do not use `0.0.0.0/0` or a public RDS endpoint workaround.
6. Use a real DNS hostname, e.g. `vault.your-domain.example`, with its A record pointing to EC2's current public IPv4 address. Remove an incorrect AAAA record. If the IP changes after a stop/start, update DNS.

Never plan the demonstration at `http://<EC2-IP>`. Encryption needs localhost or trusted HTTPS; do not disable browser security or accept an untrusted-certificate workaround.

### EC2 instance role and metadata

- Attach an IAM role trusted by the EC2 service, using an instance profile.
- Replace `REPLACE_WITH_BUCKET_NAME` in `infra/iam-s3-policy.example.json` with the actual bucket name and attach this narrowly scoped object policy to that role.
- Require IMDSv2. For this Compose bridge-network layout, configure the metadata response hop limit to **2** so containers can retrieve the role credentials.
- Leave static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` out of container configuration. Do not bake profiles, `.aws` directories, or keys into images.
- The app role does not need S3 `ListBucket`. As a consequence, HEAD of a missing object may return 403 instead of 404; the API fails closed. Check uploads and IAM rather than interpreting every 403 as an expired URL.

## 5. Private S3 configuration

Create/use a private, general-purpose, **non-versioned** lab bucket in the selected region. For this MVP its name must contain only lowercase letters, digits, and hyphens, without dots. Keep Block Public Access enabled and ACLs disabled/Bucket owner enforced. Default SSE-S3 encryption is compatible with client E2EE; the app additionally requests AES256 server-side encryption of ciphertext. This does not give AWS the vault keys.

Versioned buckets need separate version cleanup; the app's DeleteObject operation does not permanently delete historical versions. Do not enable versioning for this lab bucket unless you deliberately manage those retained objects and costs.

Edit the configuration templates **locally on the deployment machine**, not by pasting secrets into them:

- `infra/s3-public-access-block.json`: all four protections must remain true.
- `infra/s3-cors.example.json`: replace the HTTPS placeholder with the exact frontend origin, including scheme and any non-default port, without a path or trailing slash. Keep `http://localhost:5173` only if developing locally. PUT/GET/HEAD and required headers must remain allowed. No wildcard origin is needed.
- `infra/s3-bucket-policy.example.json`: replace both bucket placeholders. It denies non-HTTPS transport; it does not grant public read access.
- `infra/iam-s3-policy.example.json`: the EC2 role may operate only on `ciphertext/*` in this bucket.

An authorized operator can apply the bucket settings with AWS CLI from a configured administrative environment. These commands change existing bucket configuration; review any pre-existing bucket policy instead of blindly replacing it:

```bash
export AWS_REGION='YOUR_REGION'
export BUCKET='YOUR_PRIVATE_BUCKET'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration file://infra/s3-public-access-block.json
aws s3api put-bucket-cors --bucket "$BUCKET" \
  --cors-configuration file://infra/s3-cors.example.json
aws s3api put-bucket-policy --bucket "$BUCKET" \
  --policy file://infra/s3-bucket-policy.example.json
```

CORS is not authentication. Access still requires IAM or a valid short-lived presigned URL. Never make the bucket public to fix a transfer error. Do not log, share, or put presigned URLs into screenshots.

## 6. Put the application code and tools on EC2

The following deployment commands assume **Ubuntu 24.04 LTS, x86-64**. Other Linux distributions need their equivalent package installation steps.

1. SSH into EC2 as the authorized operator.
2. Install Docker Engine and the Docker Compose plugin using Docker's official Ubuntu instructions: <https://docs.docker.com/engine/install/ubuntu/>. Check `docker version` and `docker compose version`. Membership in the `docker` group is root-equivalent; use only a trusted operator account. Reconnect after any group-membership change.
3. Install the PostgreSQL client, Python, and HTTPS download tools:

```bash
sudo apt-get update
sudo apt-get install -y postgresql-client python3 ca-certificates curl git
```

4. Place the approved project revision in `~/imageinary`. A Git clone only includes commits already available on its remote; local commits are **not automatically pushed**. Alternatively, transfer a tracked-source archive without `.env`, AWS credentials, personal photos, or generated dependency/build directories.

For example, create an archive on Windows without pushing:

```powershell
git archive --format=tar -o "$env:TEMP\imageinary-source.tar" HEAD
scp "$env:TEMP\imageinary-source.tar" ubuntu@YOUR_EC2_HOST:~/imageinary-source.tar
```

On EC2, extract only into a new/empty directory; stop and inspect any existing deployment instead of overwriting its configuration:

```bash
mkdir ~/imageinary
tar -xf ~/imageinary-source.tar -C ~/imageinary
cd ~/imageinary
```

The SQL migration, Dockerfiles, frontend sources, backend sources, and `infra` files belong on EC2. PostgreSQL itself belongs on RDS, and photo ciphertext belongs in S3—not in EC2 container storage.

## 7. RDS TLS, migration, and application role

Download the official public RDS CA bundle on EC2:

```bash
mkdir -p "$HOME/.local/share/imageinary"
curl --fail --silent --show-error \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o "$HOME/.local/share/imageinary/rds-global-bundle.pem"
chmod 644 "$HOME/.local/share/imageinary/rds-global-bundle.pem"
```

From the repository root on EC2, connect with the RDS administrative user. These are environment variable names, not real credentials; prompts do not echo passwords:

```bash
export PGHOST='YOUR_RDS_DNS_ENDPOINT'
export PGPORT='5432'
export PGUSER='YOUR_RDS_ADMIN_USERNAME'
export PGDATABASE='postgres'
export PGSSLMODE='verify-full'
export PGSSLROOTCERT="$HOME/.local/share/imageinary/rds-global-bundle.pem"
read -r -s -p 'RDS admin password: ' PGPASSWORD; printf '\n'
export PGPASSWORD
psql -v ON_ERROR_STOP=1
```

For a **new** database and app role, run inside `psql` (choose other names consistently if needed):

```sql
CREATE DATABASE imageinary;
CREATE ROLE imageinary_app LOGIN;
\password imageinary_app
\connect imageinary
\i database/001_init.sql
GRANT CONNECT ON DATABASE imageinary TO imageinary_app;
GRANT USAGE ON SCHEMA public TO imageinary_app;
GRANT SELECT, INSERT ON TABLE vaults TO imageinary_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE media TO imageinary_app;
\q
```

Use a distinct app-role password saved in your password manager. Do not put passwords in SQL statements or shell history. If the DB/role already exists, inspect it first instead of recreating it. Reapplying `database/001_init.sql` is supported for this initial schema, but it is not a general schema-upgrade tool.

Clear the admin password from this shell:

```bash
unset PGPASSWORD
```

The running Go container uses `imageinary_app`, not the administrative user. The host's CA path above differs from the **container** CA path used in `DATABASE_URL` below.

## 8. Create the production `.env` safely

Run this from `~/imageinary` on EC2. It refuses to overwrite an existing `.env`, hides password/token input, URL-encodes DB credentials, and writes mode 0600. Use the app-role password from the previous step and the separate API credential from your password manager—not the vault passphrase.

```bash
python3 - <<'PY'
import getpass, ipaddress, json, os, re
from pathlib import Path
from urllib.parse import quote

path = Path('.env')
if path.exists():
    raise SystemExit('.env already exists. Inspect/edit it securely; do not overwrite it.')
host = input('RDS DNS endpoint (no scheme/port): ').strip()
region = input('AWS region: ').strip()
bucket = input('Private S3 bucket: ').strip()
domain = input('Public vault DNS hostname (no https:// or path): ').strip()
email = input('TLS certificate contact email: ').strip()
database = input('Database name [imageinary]: ').strip() or 'imageinary'
user = input('Application DB user [imageinary_app]: ').strip() or 'imageinary_app'
password = getpass.getpass('Application DB password: ')
token = getpass.getpass('Separate high-entropy demo API credential (32-256 ASCII characters): ')
ca = Path.home() / '.local/share/imageinary/rds-global-bundle.pem'
if not ca.is_file():
    raise SystemExit('Download the official RDS CA bundle first.')
if not re.fullmatch(r'[a-z0-9.-]+', host) or not re.fullmatch(r'[a-z0-9.-]+', domain) or '.' not in domain:
    raise SystemExit('Use DNS hostnames, not URLs, spaces, or paths.')
try:
    ipaddress.ip_address(domain)
except ValueError:
    pass
else:
    raise SystemExit('Use a real TLS DNS hostname, not an EC2 IP address.')
if not re.fullmatch(r'[a-z]{2,8}(-[a-z0-9]+)+-[0-9]+', region):
    raise SystemExit('Invalid region.')
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket):
    raise SystemExit('Use a lowercase, no-dot S3 bucket name.')
if not 32 <= len(token) <= 256 or any(not 33 <= ord(c) <= 126 for c in token):
    raise SystemExit('Invalid demo API credential.')
if not re.fullmatch(r'[A-Za-z0-9._-]+', database) or not re.fullmatch(r'[A-Za-z0-9._-]+', user):
    raise SystemExit('Use simple DB/user identifiers for this setup.')
if not email or any(c.isspace() or c in "'\"$" for c in email):
    raise SystemExit('Invalid certificate email.')
dsn = f'postgresql://{quote(user, safe="")}:{quote(password, safe="")}@{host}:5432/{quote(database, safe="")}?sslmode=verify-full&sslrootcert=/etc/ssl/certs/aws-rds-ca.pem'
values = {'DATABASE_URL': dsn, 'DEMO_API_TOKEN': token, 'S3_BUCKET': bucket,
          'AWS_REGION': region, 'DOMAIN': domain, 'ACME_EMAIL': email,
          'RDS_CA_BUNDLE': str(ca)}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    for key, value in values.items():
        # JSON quotes escape backslashes/quotes; $$ prevents interpolation.
        quoted = json.dumps(value).replace('$', '$$')
        output.write(f'{key}={quoted}\n')
print('Created .env with mode 0600. No secrets were printed.')
PY
```

Never run `source .env`: this is Compose configuration, not a shell script. Never post `docker compose config`, `docker inspect`, environment dumps, `.env`, DB URLs, or screenshots containing credentials. Use `config --quiet` for validation. The app validates required production configuration and requires verified PostgreSQL TLS; do not weaken it to `sslmode=disable` or `require` on RDS.

The production Compose file sets `APP_ENV=production`, binds Go to the private container network, mounts the CA bundle read-only, and publishes **only Caddy ports 80/443**. No frontend build arguments or `VITE_*` secrets are needed.

## 9. Build, validate, start

On EC2, from `~/imageinary`:

```bash
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml build
docker compose --env-file .env -f infra/compose.yaml run --rm --no-deps web \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file .env -f infra/compose.yaml up -d
docker compose --env-file .env -f infra/compose.yaml ps
```

Caddy automatically obtains a trusted certificate once DNS and inbound ports 80/443 work. It stores certificates in persistent `caddy_data`/`caddy_config` Docker volumes. Do not delete them during ordinary restarts. Its CSP permits ciphertext transfers only to the configured bucket's regional S3 hostname; use the same bucket/region in the app, Caddy environment, and S3 settings.

Inspect startup problems locally without publishing logs containing secrets:

```bash
docker compose --env-file .env -f infra/compose.yaml logs --tail=80 backend web
```

Open `https://YOUR_VAULT_HOSTNAME`. On the **actual demo browser/device**, verify in its console:

```javascript
window.isSecureContext && !!window.crypto.subtle
```

This must be `true` with a normally trusted certificate. Check the probes using the actual hostname:

```bash
curl --fail https://YOUR_VAULT_HOSTNAME/healthz
curl --fail https://YOUR_VAULT_HOSTNAME/readyz
```

Do not use `curl -k`, disable browser security, or replace HTTPS with the EC2 HTTP IP to make the demo pass. API/database readiness alone does not prove S3 transfer works.

## 10. First complete photo round trip

1. Enter the **demo API credential** and click **Connect API**.
2. With a new database, create the vault using a strong passphrase and confirmation. Never reset the salt or overwrite the vault to fix a wrong-password error.
3. Select a small synthetic PNG/JPEG/GIF and click **Encrypt & upload selected**. Progress moves through local encryption, original/thumbnail transfer, and server verification.
4. Confirm the encrypted gallery shows its locally decrypted thumbnail. Inspect browser Network **privately**: original and thumbnail PUT bodies must be ciphertext, with random S3 keys and `application/octet-stream`. Do not copy/log signed URLs or authorization headers.
5. Preview/download the original. An animated GIF should still animate, and downloaded bytes should match the original. Compare bytes locally, not by sending a plaintext hash to the API.
6. Lock, reload, or open another browser. Re-enter the API credential and original vault passphrase; the persisted public configuration/wrapped keys must recover access.
7. Try a wrong vault passphrase: unlock must fail. An incorrect API credential must fail independently.
8. Delete a photo and confirm both ciphertext objects and its media record disappear. Confirm any remaining objects are still private; an unsigned URL must not grant public access.

Useful RDS evidence queries avoid printing wrapped keys or encrypted metadata:

```sql
SELECT version, kdf_name, kdf_hash, kdf_iterations, octet_length(salt) AS salt_bytes FROM vaults;
SELECT status, count(*) FROM media GROUP BY status;
SELECT original_size, thumbnail_size, created_at FROM media ORDER BY created_at DESC LIMIT 5;
```

This application intentionally supports only one operator-controlled vault. It does not implement production accounts, sharing, albums, videos, password recovery, or automatic synchronization.

## 11. Tests and what they do not prove

Local frontend:

```powershell
Set-Location frontend
npm ci
npm run build
npm run test -- --run
# Either install Playwright Chromium once:
npx playwright install chromium
npm run test:e2e
# Or point Playwright at an already installed Chrome/Chromium executable:
# $env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
# $env:PLAYWRIGHT_RECOVERY_EXECUTABLE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

Local Go (from `backend`):

```powershell
go test ./...
go vet ./...
go build ./cmd/server
```

To enable real PostgreSQL integration tests, set `TEST_DATABASE_URL` to a **local test database**, then run `go test ./... -count=1`. The tests create/drop their own isolated schemas; the test user needs schema-creation permission. Do not use the production RDS app role/database for these tests. Without this variable those integration tests are explicitly skipped.

Browser workflow tests emulate API/storage responses and prove client behavior, not real S3, IAM, DNS, TLS, CORS, or RDS networking. Go storage tests use a TLS fake for transfer mechanics and test-only signing credentials. Passing these tests does not replace the actual deployed-browser round trip in section 10.

## 12. Troubleshooting

| Symptom | Check |
|---|---|
| Web Crypto unavailable | Use localhost for development or normally trusted public HTTPS; never an HTTP EC2 IP. |
| API 401 | Correct operator credential? This is separate from the vault passphrase. Lock/reconnect after changing the server token. |
| API 503 / `api_not_configured` | Backend `DEMO_API_TOKEN` absent/invalid; configure the operator credential, never a frontend build secret. |
| `/readyz` is 503 | DB endpoint/port, EC2-to-RDS SG rule, migration, app-role grants, CA mount, TLS hostname verification. |
| Container exits at startup | Validate required environment, `HOST`, bucket/region pair, production DB URL and CA permissions. Inspect sanitized logs locally. |
| Caddy cannot issue certificate | DNS A/AAAA records, public EC2 IP, ports 80/443, outbound network, hostname and ACME rate limits. |
| Browser transfer/network/CORS error | Exact S3 allowed origin, PUT/GET/HEAD, headers, bucket/region consistency, Caddy CSP, network, IAM. Do not make S3 public. |
| S3 403 / expired link | Retry for a fresh URL; check IAM role and bucket policy if persistent. URLs last about 3 minutes, possibly less if role credentials expire first. |
| EC2 role unavailable inside Docker | Instance profile attached, IMDSv2 enabled, bridge-network metadata hop limit 2, and no unintended static credential overrides. |
| Uploaded record stays pending | Both ciphertext objects must exist with expected sizes and octet-stream type before confirmation. Partial/failed transfers must not appear as ready. |
| Wrong password or tampering error | Use the original exact passphrase; do not trim/reset it or change salt/KDF values. Modified envelopes/IDs/tags must fail. |
| Thumbnail unreadable | Refresh to retry missing/expired downloads. Persistent authentication failure may indicate corrupt/substituted ciphertext. Do not render unauthenticated bytes. |
| Large image/build fails | Respect 20 MiB / 40 MP limits; check browser/EC2 RAM. Run image builds on a sufficiently sized machine. |
| Local port 8080 is occupied | Do not stop an unrelated project. Choose an unused Go `PORT` and update both proxy targets in `frontend/vite.config.ts` to match. Production Compose does not publish backend port 8080. |

Ordinary upload failures attempt cleanup. Abrupt tab closure, a lost response, expired URLs, or partial deletion can still leave pending records/orphan ciphertext. There is no automated stale-upload cleanup job. An operator must inspect and reconcile these using the DB's exact object IDs and the bucket; do not blindly empty a wanted vault or reuse old presigned URLs. Stale PUT URLs can remain usable until expiry.

## 13. Evidence, monitoring, and cleanup

- Capture EC2, instance role, private RDS/security groups, S3 Block Public Access/CORS, deployed HTTPS, ciphertext object sizes, and the successful browser flow. Hide credentials, presigned URLs, personal media, and sensitive account identifiers in screenshots.
- Optional: install/configure the CloudWatch agent on EC2 using its official AWS instructions and `infra/cloudwatch-agent.example.json`; authorize its required monitoring permissions separately. This repository does not install the agent or create log groups/dashboards. Docker logs are size-rotated locally, not automatically shipped to CloudWatch.
- Finish your presentation with the key hierarchy, private-network layout, cost choices, and limitations: web-delivered code/device compromise, visible sizes/timing, no recovery, and demo-only authentication.

If CloudWatch metrics are required for the assessment, follow the official [CloudWatch agent installation instructions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Agent-commandline-fleet.html). For the Ubuntu x86-64 host assumed here, an authorized operator can install the official package and start the supplied memory/disk configuration:

```bash
curl --fail --silent --show-error \
  https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb \
  -o /tmp/amazon-cloudwatch-agent.deb
# Follow AWS's package-signature verification instructions before installation.
sudo dpkg -i /tmp/amazon-cloudwatch-agent.deb
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c "file:$(pwd)/infra/cloudwatch-agent.example.json"
```

The instance role needs authorization to send these metrics. Prefer a namespace-scoped `cloudwatch:PutMetricData` permission for `Imageinary` when configuring this metrics-only example, or review AWS's documented managed agent policy with your lab administrator. Verify metrics appear under the `Imageinary` namespace. Custom metrics may cost credits; stop the agent when no longer needed:

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop
```

To stop only the app containers, preserving Caddy certificate volumes and cloud data:

```bash
docker compose --env-file .env -f infra/compose.yaml down
```

This does **not** stop EC2/RDS billing or remove S3 objects. After the assessment, explicitly review/approve stopping or deleting unneeded EC2/RDS resources, EBS volumes, snapshots/backups, public IPv4 allocations, S3 objects, and CloudWatch data. RDS storage/backups and retained volumes/snapshots may still cost money after compute is stopped. RDS automatic stop is temporary. Do not delete a vault you intend to keep; retain its ciphertext, public vault configuration, wrapped keys, and passphrase safely.

For the local development database, `docker stop imageinary-postgres` stops compute and preserves its volume. Do not remove `imageinary-pgdata` unless you intentionally want to destroy that local vault's metadata.

Never use broad Docker prune commands or delete unrelated containers/volumes as part of this setup. Do not stage/commit `.env`, credentials, keys, DB dumps, personal media, or the instruction Markdown files. Review staged paths before every authorized commit.
