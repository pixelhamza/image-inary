package handlers

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func NewRouter(config Config) http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.Recoverer)
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "no-store")
			next.ServeHTTP(w, r)
		})
	})
	// Public operational probes carry no vault configuration or credentials.
	router.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
	})
	router.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if config.CheckDatabase == nil || config.CheckDatabase(ctx) != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("{\"status\":\"not_ready\"}\n"))
			return
		}
		_, _ = w.Write([]byte("{\"status\":\"ready\"}\n"))
	})
	api := &apiHandler{repo: config.Repository, objects: config.Storage}
	router.Route("/api", func(r chi.Router) {
		r.Use(authenticate(config.DemoCredential))
		r.Use(middleware.Timeout(15 * time.Second))
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if api.repo == nil {
					writeError(w, http.StatusServiceUnavailable, "database_unavailable")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/vault", api.getVault)
		r.Post("/vault", api.createVault)
		r.Get("/media", api.listMedia)
		r.Post("/media/upload-url", api.uploadURL)
		r.Post("/media", api.confirmMedia)
		r.Get("/media/{id}/download-url", api.downloadURL)
		r.Delete("/media/{id}", api.deleteMedia)
	})
	return router
}
