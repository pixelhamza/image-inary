package database

import (
	"errors"
	"regexp"
	"time"
)

var (
	ErrInvalid     = errors.New("invalid database record")
	ErrNotFound    = errors.New("record not found")
	ErrConflict    = errors.New("record conflicts with existing state")
	ErrUnavailable = errors.New("database unavailable")
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

const (
	EnvelopeOverhead = 29
	MaxOriginalSize  = 20*1024*1024 + EnvelopeOverhead
	MaxThumbnailSize = 1024*1024 + EnvelopeOverhead
	MaxMetadataSize  = 16*1024 + EnvelopeOverhead
)

// []byte JSON fields use standard padded base64, matching the browser config.
type KDFConfig struct {
	Name       string `json:"name"`
	Hash       string `json:"hash"`
	Iterations int    `json:"iterations"`
	Salt       []byte `json:"salt"`
}

type VaultConfig struct {
	Version  int       `json:"version"`
	ID       string    `json:"id"`
	KDF      KDFConfig `json:"kdf"`
	Verifier []byte    `json:"verifier"`
}

type Media struct {
	ID                string    `json:"id"`
	VaultID           string    `json:"vaultId"`
	Version           int       `json:"version"`
	OriginalKey       string    `json:"-"`
	ThumbnailKey      string    `json:"-"`
	OriginalSize      int64     `json:"originalSize"`
	ThumbnailSize     int64     `json:"thumbnailSize"`
	WrappedKey        []byte    `json:"wrappedKey"`
	EncryptedMetadata []byte    `json:"metadata"`
	Status            string    `json:"status"`
	CreatedAt         time.Time `json:"createdAt"`
}

func ValidID(id string) bool { return uuidPattern.MatchString(id) }

func envelope(value []byte, minSize, maxSize int) bool {
	return len(value) >= minSize && len(value) <= maxSize && value[0] == 1
}

func (v VaultConfig) Validate() error {
	if !ValidID(v.ID) || v.Version != 1 || v.KDF.Name != "PBKDF2" ||
		v.KDF.Hash != "SHA-256" || v.KDF.Iterations != 600000 ||
		len(v.KDF.Salt) != 16 || !envelope(v.Verifier, 53, 53) {
		return ErrInvalid
	}
	return nil
}

// The server can check envelope shape and limits, not authenticate ciphertext.
func (m Media) ValidatePending() error {
	if !ValidID(m.ID) || !ValidID(m.VaultID) || !ValidID(m.OriginalKey) ||
		!ValidID(m.ThumbnailKey) || m.OriginalKey == m.ThumbnailKey || m.Version != 1 ||
		m.Status != "pending" || m.OriginalSize < 30 || m.OriginalSize > MaxOriginalSize ||
		m.ThumbnailSize < 30 || m.ThumbnailSize > MaxThumbnailSize ||
		!envelope(m.WrappedKey, 61, 61) || !envelope(m.EncryptedMetadata, EnvelopeOverhead, MaxMetadataSize) {
		return ErrInvalid
	}
	return nil
}
