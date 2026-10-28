package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func syntheticEnvelope(size int) []byte {
	value := make([]byte, size)
	if size > 0 {
		value[0] = 1
	}
	return value
}

func testVault() VaultConfig {
	return VaultConfig{
		Version: 1, ID: "11111111-1111-4111-8111-111111111111",
		KDF:      KDFConfig{Name: "PBKDF2", Hash: "SHA-256", Iterations: 600000, Salt: make([]byte, 16)},
		Verifier: syntheticEnvelope(53),
	}
}

func testMedia() Media {
	return Media{
		ID: "22222222-2222-4222-8222-222222222222", VaultID: testVault().ID, Version: 1,
		OriginalKey:  "33333333-3333-4333-8333-333333333333",
		ThumbnailKey: "44444444-4444-4444-8444-444444444444",
		OriginalSize: 1024, ThumbnailSize: 256, WrappedKey: syntheticEnvelope(61),
		EncryptedMetadata: syntheticEnvelope(64), Status: "pending",
	}
}

func TestVaultValidation(t *testing.T) {
	if err := testVault().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, alter := range map[string]func(*VaultConfig){
		"invalid ID":       func(v *VaultConfig) { v.ID = "photo.jpg" },
		"noncanonical ID":  func(v *VaultConfig) { v.ID = "ABCDEFAB-1111-4111-8111-111111111111" },
		"version":          func(v *VaultConfig) { v.Version = 2 },
		"KDF name":         func(v *VaultConfig) { v.KDF.Name = "unknown" },
		"KDF hash":         func(v *VaultConfig) { v.KDF.Hash = "SHA-1" },
		"iterations":       func(v *VaultConfig) { v.KDF.Iterations = 1 },
		"salt length":      func(v *VaultConfig) { v.KDF.Salt = nil },
		"verifier length":  func(v *VaultConfig) { v.Verifier = nil },
		"verifier version": func(v *VaultConfig) { v.Verifier[0] = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			v := testVault()
			alter(&v)
			if !errors.Is(v.Validate(), ErrInvalid) {
				t.Error("expected invalid vault")
			}
		})
	}
}

func TestMediaValidation(t *testing.T) {
	if err := testMedia().ValidatePending(); err != nil {
		t.Fatal(err)
	}
	for name, alter := range map[string]func(*Media){
		"ID":                      func(m *Media) { m.ID = "invalid" },
		"vault ID":                func(m *Media) { m.VaultID = "invalid" },
		"arbitrary original key":  func(m *Media) { m.OriginalKey = "another-vault/photo.jpg" },
		"arbitrary thumbnail key": func(m *Media) { m.ThumbnailKey = "thumbnail.gif" },
		"same object keys":        func(m *Media) { m.ThumbnailKey = m.OriginalKey },
		"version":                 func(m *Media) { m.Version = 2 },
		"already ready":           func(m *Media) { m.Status = "ready" },
		"missing state":           func(m *Media) { m.Status = "" },
		"empty original":          func(m *Media) { m.OriginalSize = 29 },
		"large original":          func(m *Media) { m.OriginalSize = MaxOriginalSize + 1 },
		"empty thumbnail":         func(m *Media) { m.ThumbnailSize = 0 },
		"large thumbnail":         func(m *Media) { m.ThumbnailSize = MaxThumbnailSize + 1 },
		"plaintext key length":    func(m *Media) { m.WrappedKey = make([]byte, 32) },
		"wrapped version":         func(m *Media) { m.WrappedKey[0] = 2 },
		"empty metadata":          func(m *Media) { m.EncryptedMetadata = nil },
		"large metadata":          func(m *Media) { m.EncryptedMetadata = syntheticEnvelope(MaxMetadataSize + 1) },
		"metadata version":        func(m *Media) { m.EncryptedMetadata[0] = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			m := testMedia()
			alter(&m)
			if !errors.Is(m.ValidatePending(), ErrInvalid) {
				t.Error("expected invalid media")
			}
		})
	}
}

func TestJSONCompatibility(t *testing.T) {
	data, err := json.Marshal(testVault())
	if err != nil {
		t.Fatal(err)
	}
	var restored VaultConfig
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if err := restored.Validate(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"salt":"AAAAAAAAAAAAAAAAAAAAAA=="`) {
		t.Error("salt must be padded base64 compatible with browser config")
	}
	data, err = json.Marshal(testMedia())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), testMedia().OriginalKey) || strings.Contains(string(data), testMedia().ThumbnailKey) {
		t.Error("internal object keys must not appear in JSON")
	}
}

func TestErrorClassification(t *testing.T) {
	for _, test := range []struct{ input, want error }{
		{nil, nil}, {pgx.ErrNoRows, ErrNotFound}, {context.Canceled, context.Canceled},
		{context.DeadlineExceeded, context.DeadlineExceeded},
		{fmt.Errorf("sensitive driver detail: %w", context.Canceled), context.Canceled},
		{fmt.Errorf("sensitive driver detail: %w", context.DeadlineExceeded), context.DeadlineExceeded},
		{&pgconn.PgError{Code: "23505", Detail: "sensitive row data"}, ErrConflict},
		{&pgconn.PgError{Code: "23503"}, ErrNotFound},
		{&pgconn.PgError{Code: "23514"}, ErrInvalid},
		{&pgconn.PgError{Code: "23502"}, ErrInvalid},
		{&pgconn.PgError{Code: "22P02"}, ErrInvalid},
		{errors.New("postgres://secret-connection-details"), ErrUnavailable},
	} {
		if got := classify(test.input); got != test.want {
			t.Errorf("unexpected classified error: %v", got)
		}
	}
}

func TestOpenRejectsInvalidConnectionURLWithoutLeakingIt(t *testing.T) {
	_, err := Open(context.Background(), "postgres://user:private-value@localhost:bad-port/db")
	if !errors.Is(err, ErrUnavailable) {
		t.Error("expected sanitized connection failure")
	}
}
