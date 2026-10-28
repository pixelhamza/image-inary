# Imageinary key hierarchy and envelope v1

## Vault
Create a random UUIDv4 vault ID and 16-byte random salt. PBKDF2-HMAC-SHA256 with exactly 600,000 iterations derives a non-extractable 256-bit AES-GCM key-encryption key (KEK). New passphrases require at least 12 characters; never trim or normalize them. Encode passphrases as UTF-8 exactly as entered.

Persist the public configuration: `version: 1`, `id`, `kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt }`, and `verifier`. Salt and verifier are canonical padded base64. The verifier encrypts UTF-8 `Imageinary vault verifier v1` using the KEK and vault-check context. Unlock validates the bounded configuration, derives the KEK, and authenticates the verifier. Never persist the passphrase or KEK. Configuration persistence is a later API/database milestone.

## Photo
Each photo has an expected random UUIDv4 media ID and a fresh random 32-byte data-encryption key (DEK). Import the DEK as a non-extractable AES-GCM key. Wrap its raw bytes using authenticated AES-GCM under the KEK; zero the temporary raw byte buffer afterward (best effort, not guaranteed memory erasure).

Use the DEK with separate fresh random 12-byte IVs to encrypt the unchanged original bytes, a locally rendered static PNG thumbnail (longest edge at most 320 pixels), and UTF-8 JSON metadata (`version`, `name`, detected `mime`, `width`, `height`, `size`, `lastModified`). Original EXIF remains inside the encrypted original; do not separately expose it. Animated GIF originals remain unchanged; thumbnails may be static.

The ciphertext-only photo record contains `version`, `wrappedKey`, `original`, `thumbnail`, and `metadata`. Each binary field is a complete envelope. It contains no plaintext photo metadata. The API will associate this record with the expected vault/media IDs and random S3 keys; decryption must use those expected IDs, not identities taken from ciphertext.

## Envelope and context
Every encryption, including key wrapping and the verifier, produces:

```text
[version: 1 byte = 0x01][IV: 12 bytes][ciphertext][GCM tag: 16 bytes]
```

Minimum length is 29 bytes. Web Crypto appends the 128-bit tag. Reject unknown versions, truncated envelopes, and authentication failures; never return unauthenticated plaintext.

AAD is UTF-8 of `JSON.stringify(["imageinary", 1, vaultId, mediaId, purpose])`. IDs are canonical lowercase UUIDv4 strings. Purpose is one of `original`, `thumbnail`, `metadata`, `key-wrap`, or `vault-check`. For `vault-check`, use the vault ID as the media ID. This fixed array encoding and distinct purposes prevent cross-vault, cross-photo, and cross-operation substitution.

Fresh random IVs are generated independently for every operation. Do not add deterministic IVs or encrypt twice with a reused IV. Recovery requires the original public vault configuration, wrapped DEKs, ciphertext records, expected IDs, and exactly the same passphrase. Cross-browser tests must transfer only those public/ciphertext values, never CryptoKey objects or plaintext keys.
