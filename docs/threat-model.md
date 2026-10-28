# Imageinary lab threat model

## Boundary and assets
Photos, filenames, original EXIF/GPS, thumbnails, vault passphrases, and unwrapped keys stay in the browser. Only ciphertext, wrapped photo keys, public vault configuration, random identifiers, sizes, and operational timestamps may reach the API/RDS/S3. Originals are encrypted without re-encoding. Thumbnail rendering is local.

## Protection and assumptions
- Web Crypto PBKDF2 and AES-256-GCM protect content confidentiality and authenticate each envelope, including its vault, media ID, version, and purpose.
- HTTPS or localhost is mandatory. A deployed demo must verify the secure context on its actual device. Private S3, correct CORS, narrow presigned URLs, and EC2-role permissions are separate deployment gates, not established by local crypto tests.
- API access must use an operator-entered demo credential separate from the vault passphrase. This is not production authentication. Presigned URLs are temporary bearer credentials and must not be logged.
- Browser, operating system, Web Crypto implementation, random-number generator, and delivered client code are trusted. No third-party scripts are needed.

## Limits and failures
- A malicious/compromised web server can deliver JavaScript that steals passphrases or unlocked photos. E2EE does not prevent this; a separately distributed trusted client is future work.
- A compromised device, browser extension, XSS, or screenshots can expose unlocked content. Keys are kept in memory, not localStorage; dropping references cannot guarantee JavaScript memory erasure.
- Public salts/verifiers and ciphertext permit offline password guessing. PBKDF2 slows guessing; strong passphrases are essential. There is no password recovery or passphrase change in this phase.
- Storage can delete, omit, or replay valid old records. Authentication does not establish freshness, completeness, or availability.
- Sizes, access patterns, object counts, and timestamps leak. Never send plaintext photo hashes or original filenames to the API.
- Reject wrong passphrases, altered tags/ciphertext, ID/purpose substitution, invalid configuration, and malformed/unsupported envelopes. Random IV uniqueness is probabilistic; use fresh cryptographic 96-bit IVs for every operation and independent photo keys.

This is an unaudited educational MVP, not a production-security claim. The current crypto phase has no AWS transfer or server persistence.
