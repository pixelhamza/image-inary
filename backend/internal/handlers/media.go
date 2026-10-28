package handlers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"imageinary/backend/internal/database"
	"imageinary/backend/internal/storage"
)

type uploadIntent struct {
	ID            string `json:"id"`
	Version       int    `json:"version"`
	OriginalSize  int64  `json:"originalSize"`
	ThumbnailSize int64  `json:"thumbnailSize"`
	WrappedKey    []byte `json:"wrappedKey"`
	Metadata      []byte `json:"metadata"`
}

func (a *apiHandler) uploadURL(w http.ResponseWriter, r *http.Request) {
	if !a.requireStorage(w) {
		return
	}
	var input uploadIntent
	if !decodeJSON(w, r, &input) {
		return
	}
	vault, ok := a.vault(w, r)
	if !ok {
		return
	}
	media := database.Media{
		ID: input.ID, VaultID: vault.ID, Version: input.Version,
		OriginalKey: randomID(), ThumbnailKey: randomID(),
		OriginalSize: input.OriginalSize, ThumbnailSize: input.ThumbnailSize,
		WrappedKey: input.WrappedKey, EncryptedMetadata: input.Metadata, Status: "pending",
	}
	if err := media.ValidatePending(); err != nil {
		repositoryError(w, err)
		return
	}
	// URLs are not returned until both signing and pending-record persistence succeed.
	original, err := a.objects.SignPut(r.Context(), media.OriginalKey, media.OriginalSize)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	thumbnail, err := a.objects.SignPut(r.Context(), media.ThumbnailKey, media.ThumbnailSize)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if _, err := a.repo.CreatePendingMedia(r.Context(), media); err != nil {
		repositoryError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": media.ID, "original": original, "thumbnail": thumbnail})
}

func (a *apiHandler) confirmMedia(w http.ResponseWriter, r *http.Request) {
	if !a.requireStorage(w) {
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if !database.ValidID(input.ID) {
		writeError(w, http.StatusBadRequest, "invalid_id")
		return
	}
	vault, ok := a.vault(w, r)
	if !ok {
		return
	}
	media, err := a.repo.GetMedia(r.Context(), vault.ID, input.ID)
	if err != nil {
		repositoryError(w, err)
		return
	}
	for _, object := range []struct {
		key  string
		size int64
	}{
		{media.OriginalKey, media.OriginalSize}, {media.ThumbnailKey, media.ThumbnailSize},
	} {
		info, err := a.objects.Head(r.Context(), object.key)
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusConflict, "upload_not_verified")
			return
		}
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if info.Size != object.size || info.ContentType != storage.CiphertextContentType {
			writeError(w, http.StatusConflict, "upload_not_verified")
			return
		}
	}
	confirmed, err := a.repo.ConfirmMedia(r.Context(), vault.ID, media.ID, media.OriginalSize, media.ThumbnailSize)
	if err != nil {
		repositoryError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, confirmed)
}

func (a *apiHandler) ownedMedia(w http.ResponseWriter, r *http.Request) (database.Media, bool) {
	id := chi.URLParam(r, "id")
	if !database.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid_id")
		return database.Media{}, false
	}
	vault, ok := a.vault(w, r)
	if !ok {
		return database.Media{}, false
	}
	media, err := a.repo.GetMedia(r.Context(), vault.ID, id)
	if err != nil {
		repositoryError(w, err)
		return database.Media{}, false
	}
	return media, true
}

func (a *apiHandler) downloadURL(w http.ResponseWriter, r *http.Request) {
	if !a.requireStorage(w) {
		return
	}
	variant := r.URL.Query().Get("variant")
	if variant != "" && variant != "original" && variant != "thumbnail" {
		writeError(w, http.StatusBadRequest, "invalid_variant")
		return
	}
	media, ok := a.ownedMedia(w, r)
	if !ok {
		return
	}
	if media.Status != "ready" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	key := media.OriginalKey
	if variant == "thumbnail" {
		key = media.ThumbnailKey
	}
	signed, err := a.objects.SignGet(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, signed)
}

func (a *apiHandler) deleteMedia(w http.ResponseWriter, r *http.Request) {
	if !a.requireStorage(w) {
		return
	}
	id := chi.URLParam(r, "id")
	if !database.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid_id")
		return
	}
	vault, ok := a.vault(w, r)
	if !ok {
		return
	}
	media, err := a.repo.GetMedia(r.Context(), vault.ID, id)
	if errors.Is(err, database.ErrNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		repositoryError(w, err)
		return
	}
	for _, key := range []string{media.OriginalKey, media.ThumbnailKey} {
		if err := a.objects.Delete(r.Context(), key); err != nil {
			writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
	}
	if err := a.repo.DeleteMedia(r.Context(), vault.ID, media.ID); err != nil && !errors.Is(err, database.ErrNotFound) {
		repositoryError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
