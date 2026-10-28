package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"imageinary/backend/internal/database"
)

const maxJSONBytes = 32 * 1024

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "expected_json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err = decoder.Decode(destination)
	if err == nil {
		var extra any
		if trailing := decoder.Decode(&extra); trailing != io.EOF {
			if trailing == nil {
				trailing = errors.New("multiple JSON values")
			}
			err = trailing
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid_json")
		}
		return false
	}
	return true
}

func repositoryError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, database.ErrInvalid):
		writeError(w, http.StatusBadRequest, "invalid_record")
	case errors.Is(err, database.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, database.ErrConflict):
		writeError(w, http.StatusConflict, "conflict")
	default:
		writeError(w, http.StatusServiceUnavailable, "database_unavailable")
	}
}
