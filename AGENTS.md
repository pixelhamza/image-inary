# AGENTS.md — imageinary 

## Mission
Deliver a minimal, understandable AWS LA2 demonstration on 27 October 2026: a desktop-friendly React gallery that encrypts photos locally and stores only ciphertext on AWS. The long-term product is an E2EE photo vault; video support is explicitly out of scope. Do not overengineer.

## Locked stack
- React + TypeScript + Vite + Tailwind CSS; **browser Web Crypto API**, not Go/WASM for LA2.
- Go + Chi single backend, Docker on EC2.
- PostgreSQL on RDS; private S3 bucket for ciphertext.
- IAM instance role, VPC/security groups, HTTPS, basic CloudWatch.
- Later only: Go/WASM crypto, mobile/desktop packaging, Terraform, sync, sharing. No video implementation in this project phase.

## Non-negotiable security and demo rules
1. **HTTPS first:** `crypto.subtle` requires a secure context (`https://` or localhost). Never plan to demo encryption at `http://<EC2-IP>`. Establish a valid TLS hostname/endpoint and verify `window.isSecureContext && !!crypto.subtle` on the actual demo device. Do not disable browser security or use insecure-context workarounds.
2. **S3 CORS first:** allow the actual frontend origin and required PUT/GET/HEAD methods and headers for presigned transfers. Keep S3 Block Public Access on. Test a real browser upload and download.
3. **Keep passphrase and plaintext local:** never transmit vault passphrase, plaintext media, thumbnails, unwrapped keys, or plaintext EXIF to Go, RDS or S3. Never log them.
4. **Separate access control from encryption:** protect API operations using a demo-only server-validated credential, supplied by the operator (never embed a permanent token in the frontend bundle). The vault passphrase is not an API password. Document that this is not production authentication.
5. **Web Crypto MVP:** PBKDF2-HMAC-SHA256, random per-vault salt, baseline 600,000 iterations, AES-256-GCM with a fresh cryptographically random 96-bit IV per encryption. Test KDF responsiveness and wrong-password failure.
6. **Per-photo keys:** generate random 256-bit keys for each photo; use the passphrase-derived key as a KEK to wrap them using authenticated encryption (or Web Crypto AES-KW). Persist wrapped keys, wrap parameters and vault salt so the same passphrase can unlock from a different browser. Encrypt thumbnails and encrypted metadata; separate IVs for each operation. Never reuse an (AES-GCM key, IV) pair.
7. **Versioned envelope:** define a documented binary format such as `[version:1][iv:12][ciphertext+GCM tag]`. Authenticate version and the expected random media ID with AES-GCM `additionalData` using a canonical encoding. Reject unsupported versions, tampering and ID substitution. Do not use guessable filenames as object keys.
8. **Minimize leakage:** use UUIDv4/random S3 object keys; encrypt filenames, EXIF, GPS, capture time and sensitive labels. Operational size and upload timestamps may still be visible to the server. Do not send plaintext SHA-256 fingerprints to the backend.
9. **Presigned transfers:** the API authorizes and signs narrowly scoped, short-lived object operations; the browser transfers ciphertext directly. Verify uploaded objects before committing metadata; enforce size/type limits and avoid arbitrary-key signing.
10. **AWS basics:** EC2 role with least-privilege S3 permissions, RDS not public, DB inbound only from EC2 security group, no embedded AWS keys, no public S3 objects, no unnecessary NAT gateway/ALB. S3's default server-side encryption may additionally protect ciphertext; it does not replace or invalidate client E2EE.
11. **Crypto tests:** round-trip, wrong passphrase, modified ciphertext/tag, wrong media ID, malformed/unsupported envelope, fresh IV behavior, cross-browser vault unlock. Do not implement custom crypto primitives or video chunk protocols for LA2.
12. **Photo-only validation:** accept PNG, JPEG (.jpg/.jpeg), and GIF; validate file signatures/MIME rather than extension alone. Preserve original GIF bytes and animation; a static thumbnail is acceptable. Encrypt original bytes without re-encoding. Enforce reasonable upload size limits and report unsupported/corrupt files clearly.
13. Keep code small and readable. No Kubernetes, Redis, microservices, Lambda requirement, Cognito, Terraform, CI/CD or elaborate patterns for LA2. Never claim a feature works until tested.

## Architecture boundaries
- `frontend/src/crypto/`: a small TypeScript crypto interface, independently testable and replaceable with Go/WASM later.
- `frontend/src/api/`: gallery/API client; never owns the vault passphrase.
- `backend/`: authorization, metadata, presigned URL generation and storage adapter; no plaintext processing.
- `storage/`: define a narrow storage contract for signed put/get, list and delete; S3 adapter first, self-hosted adapter later. Keep server storage operations distinct from direct browser transfers.
- `database/`: one minimal media table plus a vault configuration record for public salt/KDF parameters and wrapped keys (schema to be finalized during implementation).

## Suggested layout
```text
frontend/src/{components,crypto,api}/
backend/{cmd/server,internal/{handlers,database,storage}}/
storage/
database/
docs/{threat-model.md,key-hierarchy.md}/
infra/
AGENTS.md  CONTEXT.md  README.md  .gitignore  .env.example
```

## Priority and acceptance
1. Read CONTEXT.md; write concise threat model and key hierarchy before crypto code.
2. Prove deployed HTTPS hello-world and presigned S3 browser PUT/GET with correct CORS (localhost is fine during development).
3. Implement/test local crypto, encrypted original + thumbnail, wrapped per-photo key, persistent vault salt.
4. Implement Go API, RDS metadata and React gallery with upload/preview/download/delete.
5. Capture AWS evidence and prepare PPT. No video support for LA2; do not implement it even if time remains.

## Git and secrets
Use focused commits. Never commit `.env`, credentials, passphrases, AWS keys, database dumps, or personal media. Keep `$100` college credits in mind; set billing alerts and stop/delete idle resources. Do not create AWS resources unless explicitly instructed.



## Documentation and Git Restrictions (STRICT)

- DO NOT create, modify, rename, or delete any Markdown (`.md`) files without explicit user permission.
- DO NOT generate unnecessary documentation, reports, summaries, or additional README files.
- NEVER stage, commit, or push `AGENTS.md`, `CONTEXT.md`, `COMMIT_PLAN.md` or ANY other `.md` except `README.md` file unless the user explicitly authorizes that specific file.
- Before every commit, inspect `git diff --cached --name-only` and ensure no unauthorized files are staged.
- These restrictions apply even when documentation updates seem necessary or beneficial.

