package storage

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound       = errors.New("ciphertext object not found")
	ErrUnavailable    = errors.New("ciphertext storage unavailable")
	ErrInvalidRequest = errors.New("invalid ciphertext storage request")
)

const CiphertextContentType = "application/octet-stream"

type SignedURL struct {
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expiresAt"`
}

type ObjectInfo struct {
	Size        int64
	ContentType string
}

// The browser transfers ciphertext directly, never through these server methods.
// Keys must come from authorized server-generated records. Gallery listing uses
// the database index, not S3 bucket enumeration.
type Store interface {
	SignPut(context.Context, string, int64) (SignedURL, error)
	SignGet(context.Context, string) (SignedURL, error)
	Head(context.Context, string) (ObjectInfo, error)
	// Delete must be idempotent, including when an object is already absent.
	Delete(context.Context, string) error
}
