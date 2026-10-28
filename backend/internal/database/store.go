package database

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ pool *pgxpool.Pool }

func Open(ctx context.Context, connectionURL string) (*Store, error) {
	config, err := pgxpool.ParseConfig(connectionURL)
	if err != nil {
		return nil, ErrUnavailable
	}
	config.MaxConns = 4
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnIdleTime = 5 * time.Minute
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, ErrUnavailable
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, ErrUnavailable
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close()                         { s.pool.Close() }
func (s *Store) Ping(ctx context.Context) error { return classify(s.pool.Ping(ctx)) }

// Connectivity alone is insufficient: an unmigrated database is not ready.
func (s *Store) Ready(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `SELECT v.id, v.salt, v.verifier, m.id, m.wrapped_key,
		m.encrypted_metadata FROM vaults v, media m LIMIT 0`)
	return classify(err)
}

// Do not expose driver errors: they may contain connection details or row data.
func classify(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) {
		switch pgError.Code {
		case "23505":
			return ErrConflict
		case "23503":
			return ErrNotFound
		case "23514", "23502", "22P02":
			return ErrInvalid
		}
	}
	return ErrUnavailable
}

func (s *Store) CreateVault(ctx context.Context, v VaultConfig) error {
	if err := v.Validate(); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO vaults
		(id, version, kdf_name, kdf_hash, kdf_iterations, salt, verifier)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		v.ID, v.Version, v.KDF.Name, v.KDF.Hash, v.KDF.Iterations, v.KDF.Salt, v.Verifier)
	return classify(err)
}

func (s *Store) GetVault(ctx context.Context) (VaultConfig, error) {
	var v VaultConfig
	err := s.pool.QueryRow(ctx, `SELECT id::text, version, kdf_name, kdf_hash,
		kdf_iterations, salt, verifier FROM vaults WHERE singleton = TRUE`).Scan(
		&v.ID, &v.Version, &v.KDF.Name, &v.KDF.Hash, &v.KDF.Iterations, &v.KDF.Salt, &v.Verifier)
	return v, classify(err)
}

const mediaColumns = `id::text, vault_id::text, version, original_key::text,
	thumbnail_key::text, original_size, thumbnail_size, wrapped_key, encrypted_metadata, status, created_at`

func scanMedia(row pgx.Row) (Media, error) {
	var m Media
	err := row.Scan(&m.ID, &m.VaultID, &m.Version, &m.OriginalKey, &m.ThumbnailKey,
		&m.OriginalSize, &m.ThumbnailSize, &m.WrappedKey, &m.EncryptedMetadata, &m.Status, &m.CreatedAt)
	return m, classify(err)
}

func (s *Store) CreatePendingMedia(ctx context.Context, m Media) (Media, error) {
	if err := m.ValidatePending(); err != nil {
		return Media{}, err
	}
	return scanMedia(s.pool.QueryRow(ctx, `INSERT INTO media
		(id, vault_id, version, original_key, thumbnail_key, original_size, thumbnail_size,
		wrapped_key, encrypted_metadata, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
		RETURNING `+mediaColumns, m.ID, m.VaultID, m.Version, m.OriginalKey, m.ThumbnailKey,
		m.OriginalSize, m.ThumbnailSize, m.WrappedKey, m.EncryptedMetadata))
}

func (s *Store) GetMedia(ctx context.Context, vaultID, id string) (Media, error) {
	if !ValidID(vaultID) || !ValidID(id) {
		return Media{}, ErrInvalid
	}
	return scanMedia(s.pool.QueryRow(ctx, `SELECT `+mediaColumns+` FROM media
		WHERE vault_id = $1 AND id = $2`, vaultID, id))
}

func (s *Store) ListReadyMedia(ctx context.Context, vaultID string, limit int) ([]Media, error) {
	if !ValidID(vaultID) || limit < 1 || limit > 100 {
		return nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT `+mediaColumns+` FROM media
		WHERE vault_id = $1 AND status = 'ready' ORDER BY created_at DESC, id DESC LIMIT $2`, vaultID, limit)
	if err != nil {
		return nil, classify(err)
	}
	defer rows.Close()
	media := make([]Media, 0)
	for rows.Next() {
		m, err := scanMedia(rows)
		if err != nil {
			return nil, err
		}
		media = append(media, m)
	}
	return media, classify(rows.Err())
}

// The caller must HEAD both authorized S3 objects first and pass the measured
// ciphertext lengths. This repository does not perform or attest S3 verification.
func (s *Store) ConfirmMedia(ctx context.Context, vaultID, id string, originalSize, thumbnailSize int64) (Media, error) {
	m, err := s.GetMedia(ctx, vaultID, id)
	if err != nil {
		return Media{}, err
	}
	if m.OriginalSize != originalSize || m.ThumbnailSize != thumbnailSize {
		return Media{}, ErrConflict
	}
	return scanMedia(s.pool.QueryRow(ctx, `UPDATE media SET status = 'ready'
		WHERE vault_id = $1 AND id = $2 AND original_size = $3 AND thumbnail_size = $4
		RETURNING `+mediaColumns, vaultID, id, originalSize, thumbnailSize))
}

// The caller must delete both S3 objects before deleting their index record.
func (s *Store) DeleteMedia(ctx context.Context, vaultID, id string) error {
	if !ValidID(vaultID) || !ValidID(id) {
		return ErrInvalid
	}
	result, err := s.pool.Exec(ctx, `DELETE FROM media WHERE vault_id = $1 AND id = $2`, vaultID, id)
	if err != nil {
		return classify(err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
