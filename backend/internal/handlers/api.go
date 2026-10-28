package handlers

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"strconv"

	"imageinary/backend/internal/database"
	"imageinary/backend/internal/storage"
)

type Repository interface {
	CreateVault(context.Context, database.VaultConfig) error
	GetVault(context.Context) (database.VaultConfig, error)
	CreatePendingMedia(context.Context, database.Media) (database.Media, error)
	GetMedia(context.Context, string, string) (database.Media, error)
	ListReadyMedia(context.Context, string, int) ([]database.Media, error)
	ConfirmMedia(context.Context, string, string, int64, int64) (database.Media, error)
	DeleteMedia(context.Context, string, string) error
}

type Config struct {
	CheckDatabase  func(context.Context) error
	DemoCredential string
	Repository     Repository
	Storage        storage.Store
}

type apiHandler struct {
	repo    Repository
	objects storage.Store
}

func (a *apiHandler) getVault(w http.ResponseWriter, r *http.Request) {
	vault, err := a.repo.GetVault(r.Context())
	if err != nil {
		repositoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vault)
}

func (a *apiHandler) createVault(w http.ResponseWriter, r *http.Request) {
	var vault database.VaultConfig
	if !decodeJSON(w, r, &vault) {
		return
	}
	if err := vault.Validate(); err != nil {
		repositoryError(w, err)
		return
	}
	if err := a.repo.CreateVault(r.Context(), vault); err != nil {
		repositoryError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, vault)
}

func (a *apiHandler) vault(w http.ResponseWriter, r *http.Request) (database.VaultConfig, bool) {
	vault, err := a.repo.GetVault(r.Context())
	if err != nil {
		repositoryError(w, err)
		return database.VaultConfig{}, false
	}
	return vault, true
}

func (a *apiHandler) listMedia(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if value := r.URL.Query().Get("limit"); value != "" {
		var err error
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			writeError(w, http.StatusBadRequest, "invalid_limit")
			return
		}
	}
	vault, ok := a.vault(w, r)
	if !ok {
		return
	}
	media, err := a.repo.ListReadyMedia(r.Context(), vault.ID, limit)
	if err != nil {
		repositoryError(w, err)
		return
	}
	if media == nil {
		media = []database.Media{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"media": media})
}

func (a *apiHandler) requireStorage(w http.ResponseWriter) bool {
	if a.objects == nil {
		writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
		return false
	}
	return true
}

func randomID() string {
	var bytes [16]byte
	_, _ = rand.Read(bytes[:]) // Go 1.25 rand.Read terminates on entropy failure.
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}
