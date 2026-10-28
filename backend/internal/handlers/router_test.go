package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewRouter(Config{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	for name, want := range map[string]string{
		"Content-Type":           "application/json",
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := recorder.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Errorf("unexpected response: %v", body)
	}
}

func TestUnknownRoutes(t *testing.T) {
	for _, path := range []string{"/missing", "/not-api"} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			NewRouter(Config{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
			if recorder.Code != http.StatusNotFound {
				t.Errorf("status = %d, want 404", recorder.Code)
			}
		})
	}
}

func TestHealthRejectsPost(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewRouter(Config{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", recorder.Code)
	}
}

func TestReadiness(t *testing.T) {
	for _, test := range []struct {
		name  string
		check func(context.Context) error
		want  int
	}{
		{"not configured", nil, http.StatusServiceUnavailable},
		{"database online", func(ctx context.Context) error {
			if _, ok := ctx.Deadline(); !ok {
				t.Error("database probe needs a deadline")
			}
			return nil
		}, http.StatusOK},
		{"database offline", func(context.Context) error { return errors.New("sensitive driver detail") }, http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			NewRouter(Config{CheckDatabase: test.check}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			if recorder.Code != test.want {
				t.Errorf("status = %d, want %d", recorder.Code, test.want)
			}
			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			want := "not_ready"
			if test.want == http.StatusOK {
				want = "ready"
			}
			if body["status"] != want || len(body) != 1 {
				t.Errorf("unexpected probe response: %v", body)
			}
		})
	}
}
