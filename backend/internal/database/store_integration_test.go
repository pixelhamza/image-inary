package database

import (
	"context"
	"crypto/rand"
	"errors"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPostgresIntegration(t *testing.T) {
	connectionURL := os.Getenv("TEST_DATABASE_URL")
	if connectionURL == "" {
		t.Skip("set TEST_DATABASE_URL to a local test PostgreSQL database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := Open(ctx, connectionURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	// Isolate test data even when the caller uses an existing local database.
	schema := "imageinary_test_" + strings.ToLower(rand.Text())
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.pool.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal("cannot create test schema")
	}
	defer func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if _, err := admin.pool.Exec(cleanupCtx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Error("cannot clean up isolated test schema")
		}
	}()
	parsed, err := url.Parse(connectionURL)
	if err != nil || parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	testURL := parsed.String()
	store, err := Open(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { store.Close() }()
	if err := store.Ready(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal("unmigrated database must not be ready")
	}
	migration, err := os.ReadFile("../../../database/001_init.sql")
	if err != nil {
		t.Fatal("cannot read initial SQL migration")
	}
	for i := 0; i < 2; i++ {
		if _, err := store.pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal("initial migration failed")
		}
	}
	t.Log("initial migration applied and reapplied successfully")
	if err := store.Ready(ctx); err != nil {
		t.Fatal("migrated database must be ready")
	}
	if _, err := store.GetVault(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatal("expected empty vault state")
	}

	vault := testVault()
	errorsCh := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { errorsCh <- store.CreateVault(ctx, vault) }()
	}
	success, conflict := 0, 0
	for i := 0; i < 2; i++ {
		switch err := <-errorsCh; {
		case err == nil:
			success++
		case errors.Is(err, ErrConflict):
			conflict++
		default:
			t.Fatal("unexpected concurrent initialization failure")
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("concurrent vault creation must have exactly one winner")
	}
	restoredVault, err := store.GetVault(ctx)
	if err != nil || !reflect.DeepEqual(restoredVault, vault) {
		t.Fatal("vault config did not round-trip")
	}
	otherVault := testVault()
	otherVault.ID = "55555555-5555-4555-8555-555555555555"
	if err := store.CreateVault(ctx, otherVault); !errors.Is(err, ErrConflict) {
		t.Fatal("demo must not create a second vault")
	}

	media, err := store.CreatePendingMedia(ctx, testMedia())
	if err != nil || media.CreatedAt.IsZero() || media.Status != "pending" {
		t.Fatal("pending media insertion failed")
	}
	listed, err := store.ListReadyMedia(ctx, vault.ID, 100)
	if err != nil || len(listed) != 0 {
		t.Fatal("unconfirmed media must not appear in gallery")
	}
	if _, err := store.GetMedia(ctx, otherVault.ID, media.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-vault access must fail")
	}
	if _, err := store.ConfirmMedia(ctx, vault.ID, media.ID, media.OriginalSize+1, media.ThumbnailSize); !errors.Is(err, ErrConflict) {
		t.Fatal("incorrect verified object sizes must not commit media")
	}
	for i := 0; i < 2; i++ {
		ready, err := store.ConfirmMedia(ctx, vault.ID, media.ID, media.OriginalSize, media.ThumbnailSize)
		if err != nil || ready.Status != "ready" {
			t.Fatal("confirmation must succeed and be idempotent")
		}
	}
	listed, err = store.ListReadyMedia(ctx, vault.ID, 100)
	if err != nil || len(listed) != 1 {
		t.Fatal("confirmed media must appear in gallery")
	}
	duplicate := testMedia()
	duplicate.ID = "66666666-6666-4666-8666-666666666666"
	if _, err := store.CreatePendingMedia(ctx, duplicate); !errors.Is(err, ErrConflict) {
		t.Fatal("object keys must be unique")
	}
	missingVault := testMedia()
	missingVault.ID = "77777777-7777-4777-8777-777777777777"
	missingVault.VaultID = otherVault.ID
	missingVault.OriginalKey = "88888888-8888-4888-8888-888888888888"
	missingVault.ThumbnailKey = "99999999-9999-4999-8999-999999999999"
	if _, err := store.CreatePendingMedia(ctx, missingVault); !errors.Is(err, ErrNotFound) {
		t.Fatal("media must reference an existing vault")
	}

	for _, statement := range []string{
		"UPDATE vaults SET kdf_iterations = 1",
		"UPDATE media SET original_size = 20971550",
		"UPDATE media SET status = 'unvalidated'",
		"UPDATE media SET wrapped_key = decode(repeat('00', 61), 'hex')",
	} {
		if _, err := store.pool.Exec(ctx, statement); !errors.Is(classify(err), ErrInvalid) {
			t.Fatal("database constraint did not reject invalid record")
		}
	}
	if _, err := store.ListReadyMedia(ctx, vault.ID, 101); !errors.Is(err, ErrInvalid) {
		t.Fatal("list limit must be bounded")
	}

	store.Close()
	reopened, err := Open(ctx, testURL)
	if err != nil {
		t.Fatal("reopening store failed")
	}
	store = reopened
	restoredVault, err = store.GetVault(ctx)
	if err != nil || !reflect.DeepEqual(restoredVault, vault) {
		t.Fatal("vault config was not persistent across connections")
	}
	restoredMedia, err := store.GetMedia(ctx, vault.ID, media.ID)
	if err != nil || !reflect.DeepEqual(restoredMedia.WrappedKey, media.WrappedKey) ||
		!reflect.DeepEqual(restoredMedia.EncryptedMetadata, media.EncryptedMetadata) || restoredMedia.Status != "ready" {
		t.Fatal("wrapped keys and encrypted metadata were not persistent")
	}
	if err := store.DeleteMedia(ctx, otherVault.ID, media.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-vault deletion must fail")
	}
	if err := store.DeleteMedia(ctx, vault.ID, media.ID); err != nil {
		t.Fatal("deleting metadata failed")
	}
	if _, err := store.GetMedia(ctx, vault.ID, media.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted metadata must not remain indexed")
	}
	t.Log("vault initialization races, constraints, pending/ready lifecycle, vault scoping, reconnect persistence, and deletion passed")
}
