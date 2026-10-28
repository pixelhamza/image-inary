# CONTEXT.md — Imageinary

## Identity and deadline
**Imageinary — End-to-End Encrypted Cloud Media Gallery**. AWS Cloud Computing LA2 demo: **27 October 2026**. Long-term: portable, zero-knowledge-oriented photo vault. Immediate scope: working encrypted **photo** gallery with a friendly desktop-oriented React web UI. College AWS account has approximately $100 credits; costs still matter.

## Locked choices
- Frontend: React + TypeScript + Vite + Tailwind; browser **Web Crypto API for LA2**, no Go/WASM yet.
- Backend: single Go + Chi service on AWS EC2 using Docker.
- Database: AWS RDS PostgreSQL for media index and non-secret vault configuration.
- Objects: private S3, encrypted originals and separately encrypted thumbnails.
- Supporting AWS: IAM role, VPC/security groups, optional basic CloudWatch.
- Architecture: storage adapter abstraction (S3 now, self-hosted later); avoid AWS-specific code in frontend crypto/UI.

## Critical deployment gates
1. Web Crypto requires secure context. `localhost` works for local development; **plain HTTP EC2 IP will break encryption**. Deploy behind a trusted HTTPS endpoint before the lab, then verify `window.isSecureContext` and `crypto.subtle` from the demo device. Possible paths: owned domain + Caddy/Let's Encrypt; or another valid TLS deployment path. Avoid costly ALB unless needed.
2. S3 CORS must permit the actual frontend origin, presigned PUT/GET/HEAD requests and necessary headers. Keep S3 Block Public Access enabled; use short-lived presigned URLs.
3. Test deployment and browser S3 transfer before building polish. Capture evidence from deployed AWS resources.

## E2EE key hierarchy (MVP target)
1. User enters a vault passphrase **only in browser**.
2. Web Crypto PBKDF2-HMAC-SHA256, 600,000 iterations and random persistent vault salt derive a 256-bit key-encryption key (KEK). Store salt and KDF parameters server-side; these are public, not secrets.
3. Each photo gets a fresh random 256-bit AES key (DEK); wrap the DEK with the KEK (authenticated AES-GCM wrapping or AES-KW). Persist the wrapped DEK, never plaintext DEK.
4. Encrypt original and locally generated thumbnail using AES-256-GCM and distinct random 12-byte IVs. Encrypt filename and sensitive metadata (including EXIF/GPS) client-side.
5. Define a versioned envelope, e.g. `[version:1][IV:12][ciphertext + tag]`. Bind media ID and version using canonical AES-GCM additional authenticated data (AAD), verify them during decrypt. Never reuse an IV with the same key.
6. Browser downloads ciphertext, unwraps the DEK and decrypts locally. Second-browser recovery works only if vault salt, KDF parameters and wrapped DEKs are retrievable and the same passphrase is provided. Wrong passphrase/tampering must fail safely.
7. Recovery keys, Argon2id and wrapped master-key hierarchy are post-LA2. Password loss can mean permanent data loss in MVP. No production-security/audit claims.

## Gallery UX
Friendly, moderate-quality light UI: gallery grid, upload dialog/progress, encrypted thumbnail previews, original preview modal, download and delete. Empty state and understandable errors. Only PNG, JPG/JPEG, and GIF are supported. Validate content signatures and MIME, not just extensions. Preserve animated GIF originals (static thumbnails are fine). No WebP, video, documents, transcoding or streaming for LA2. React is a browser app, not a packaged desktop executable.

## AWS flow
1. React obtains an authorized, short-lived presigned PUT URL from Go.
2. Browser generates thumbnail, encrypts original/thumbnail and uploads **ciphertext** directly to S3.
3. Go verifies object existence and persists random object keys, encrypted metadata, wrapped key and media ID in RDS.
4. Gallery requests indexed media; React fetches encrypted thumbnails using presigned GET URLs and decrypts locally.
5. Download fetches encrypted original; browser decrypts and saves it. Delete removes both objects and metadata.
6. EC2 uses IAM role for S3; RDS private and restricted to EC2 security group. No plaintext keys/media on AWS.

## Minimal planned API (not implemented)
- `POST /api/media/upload-url` — authorize and sign specific ciphertext object uploads.
- `POST /api/media` — verify uploads and commit encrypted metadata/wrapped key.
- `GET /api/media` — list vault media records.
- `GET /api/media/{id}/download-url` — sign ciphertext download (original or thumbnail).
- `DELETE /api/media/{id}` — delete authorized media and objects.
- Minimal vault configuration get/create route to persist salt/KDF parameters; define exact path during implementation.

## Security and limitations
- Authentication to API **must be separate** from vault passphrase; use a manually entered demo-only API credential, not a hardcoded browser secret. No full user-account system for lab.
- Never upload plaintext media, thumbnails, metadata or vault passphrase; use random object IDs. Server may still see size, timing and access patterns.
- HTTPS protects transport; client-side encryption protects content from storage/backend. Web-delivered JS can be compromised by a malicious web server; note this in `docs/threat-model.md`. Desktop-distributed client is a future mitigation.
- S3 server-side encryption of already-encrypted blobs is compatible with E2EE; AWS KMS is not used for vault key custody.
- Storage adapter portability is an architectural boundary, not a requirement to implement self-hosting now.

## Definition of done for LA2
From the deployed HTTPS site, encrypt/upload a photo + thumbnail, show ciphertext in private S3, show record in RDS, list/decrypt thumbnail, download/decrypt original, delete, and demonstrate wrong-password/tamper failure. Show IAM, EC2, S3, RDS, VPC and basic CloudWatch evidence. Explain crypto, limitations and AWS costs in PPT.

## Explicitly later
Go/WASM, Argon2id, secure recovery key, multi-user accounts/sharing, automatic backup/sync, native desktop app, Kubernetes, Terraform, CI/CD, advanced observability.

## Work order
Threat model + key hierarchy → HTTPS and S3 CORS smoke test → crypto tests → API/RDS → gallery UI → deployed end-to-end demo → screenshots/PPT. Do not expand scope before a working photo round trip. The supported formats are exactly .png, .jpg, .jpeg, and .gif.
