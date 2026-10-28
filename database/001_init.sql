BEGIN;

-- Public vault configuration only. No passphrase, KEK, or unwrapped photo keys.
-- A single operator-controlled demo vault; multi-user accounts are out of scope.
CREATE TABLE IF NOT EXISTS vaults (
    id UUID PRIMARY KEY CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    singleton BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
    version SMALLINT NOT NULL CHECK (version = 1),
    kdf_name TEXT NOT NULL CHECK (kdf_name = 'PBKDF2'),
    kdf_hash TEXT NOT NULL CHECK (kdf_hash = 'SHA-256'),
    kdf_iterations INTEGER NOT NULL CHECK (kdf_iterations = 600000),
    salt BYTEA NOT NULL CHECK (octet_length(salt) = 16),
    verifier BYTEA NOT NULL CHECK (octet_length(verifier) = 53 AND get_byte(verifier, 0) = 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    vault_id UUID NOT NULL REFERENCES vaults(id),
    version SMALLINT NOT NULL CHECK (version = 1),
    original_key UUID NOT NULL UNIQUE CHECK (original_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    thumbnail_key UUID NOT NULL UNIQUE CHECK (thumbnail_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CHECK (original_key <> thumbnail_key),
    original_size BIGINT NOT NULL CHECK (original_size BETWEEN 30 AND 20971549),
    thumbnail_size BIGINT NOT NULL CHECK (thumbnail_size BETWEEN 30 AND 1048605),
    wrapped_key BYTEA NOT NULL CHECK (octet_length(wrapped_key) = 61 AND get_byte(wrapped_key, 0) = 1),
    encrypted_metadata BYTEA NOT NULL CHECK (octet_length(encrypted_metadata) BETWEEN 29 AND 16413 AND get_byte(encrypted_metadata, 0) = 1),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS media_vault_status_created_idx
    ON media (vault_id, status, created_at DESC, id DESC);

COMMIT;
