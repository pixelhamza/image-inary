package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"imageinary/backend/internal/database"
	"imageinary/backend/internal/storage"
)

// Synthetic test credential, never used by the application or frontend.
const testCredential = "synthetic-test-only-credential-123456789"
const testMediaID = "22222222-2222-4222-8222-222222222222"

func testEnvelope(size int) []byte { value := make([]byte, size); value[0] = 1; return value }

func apiVault() database.VaultConfig {
	return database.VaultConfig{
		Version: 1, ID: "11111111-1111-4111-8111-111111111111",
		KDF:      database.KDFConfig{Name: "PBKDF2", Hash: "SHA-256", Iterations: 600000, Salt: make([]byte, 16)},
		Verifier: testEnvelope(53),
	}
}

func apiIntent() uploadIntent {
	return uploadIntent{ID: testMediaID, Version: 1, OriginalSize: 1024, ThumbnailSize: 256,
		WrappedKey: testEnvelope(61), Metadata: testEnvelope(64)}
}

type fakeRepository struct {
	vault   *database.VaultConfig
	media   map[string]database.Media
	calls   int
	failure error
}

func (f *fakeRepository) CreateVault(_ context.Context, v database.VaultConfig) error {
	f.calls++
	if f.failure != nil {
		return f.failure
	}
	if f.vault != nil {
		return database.ErrConflict
	}
	f.vault = &v
	return nil
}
func (f *fakeRepository) GetVault(context.Context) (database.VaultConfig, error) {
	f.calls++
	if f.failure != nil {
		return database.VaultConfig{}, f.failure
	}
	if f.vault == nil {
		return database.VaultConfig{}, database.ErrNotFound
	}
	return *f.vault, nil
}
func (f *fakeRepository) CreatePendingMedia(_ context.Context, m database.Media) (database.Media, error) {
	f.calls++
	if f.failure != nil {
		return database.Media{}, f.failure
	}
	if _, exists := f.media[m.ID]; exists {
		return database.Media{}, database.ErrConflict
	}
	m.CreatedAt = time.Now().UTC()
	f.media[m.ID] = m
	return m, nil
}
func (f *fakeRepository) GetMedia(_ context.Context, vaultID, id string) (database.Media, error) {
	f.calls++
	if f.failure != nil {
		return database.Media{}, f.failure
	}
	m, exists := f.media[id]
	if !exists || m.VaultID != vaultID {
		return database.Media{}, database.ErrNotFound
	}
	return m, nil
}
func (f *fakeRepository) ListReadyMedia(_ context.Context, vaultID string, limit int) ([]database.Media, error) {
	f.calls++
	if f.failure != nil {
		return nil, f.failure
	}
	result := []database.Media{}
	for _, m := range f.media {
		if m.VaultID == vaultID && m.Status == "ready" && len(result) < limit {
			result = append(result, m)
		}
	}
	return result, nil
}
func (f *fakeRepository) ConfirmMedia(ctx context.Context, vaultID, id string, original, thumbnail int64) (database.Media, error) {
	m, err := f.GetMedia(ctx, vaultID, id)
	if err != nil {
		return database.Media{}, err
	}
	if m.OriginalSize != original || m.ThumbnailSize != thumbnail {
		return database.Media{}, database.ErrConflict
	}
	m.Status = "ready"
	f.media[id] = m
	return m, nil
}
func (f *fakeRepository) DeleteMedia(ctx context.Context, vaultID, id string) error {
	if _, err := f.GetMedia(ctx, vaultID, id); err != nil {
		return err
	}
	delete(f.media, id)
	return nil
}

type signedPut struct {
	key  string
	size int64
}
type fakeStorage struct {
	puts           []signedPut
	gets           []string
	deleted        []string
	objects        map[string]storage.ObjectInfo
	failPut        int
	signGetError   error
	headError      error
	deleteErrorKey string
}

func (f *fakeStorage) SignPut(_ context.Context, key string, size int64) (storage.SignedURL, error) {
	f.puts = append(f.puts, signedPut{key, size})
	if len(f.puts) == f.failPut {
		return storage.SignedURL{}, storage.ErrUnavailable
	}
	return storage.SignedURL{URL: "https://ciphertext.example/" + key,
		Headers: map[string]string{"Content-Type": storage.CiphertextContentType}, ExpiresAt: time.Now().Add(3 * time.Minute)}, nil
}
func (f *fakeStorage) SignGet(_ context.Context, key string) (storage.SignedURL, error) {
	f.gets = append(f.gets, key)
	if f.signGetError != nil {
		return storage.SignedURL{}, f.signGetError
	}
	return storage.SignedURL{URL: "https://ciphertext.example/" + key, ExpiresAt: time.Now().Add(3 * time.Minute)}, nil
}
func (f *fakeStorage) Head(_ context.Context, key string) (storage.ObjectInfo, error) {
	if f.headError != nil {
		return storage.ObjectInfo{}, f.headError
	}
	info, exists := f.objects[key]
	if !exists {
		return storage.ObjectInfo{}, storage.ErrNotFound
	}
	return info, nil
}
func (f *fakeStorage) Delete(_ context.Context, key string) error {
	if key == f.deleteErrorKey {
		return storage.ErrUnavailable
	}
	f.deleted = append(f.deleted, key)
	delete(f.objects, key)
	return nil
}

func testAPI() (http.Handler, *fakeRepository, *fakeStorage) {
	vault := apiVault()
	repo := &fakeRepository{vault: &vault, media: make(map[string]database.Media)}
	objects := &fakeStorage{objects: make(map[string]storage.ObjectInfo)}
	return NewRouter(Config{DemoCredential: testCredential, Repository: repo, Storage: objects}), repo, objects
}

func bodyJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func request(router http.Handler, method, path, body, credential string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func wantStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, want, response.Body.String())
	}
}

func TestDemoCredentialValidation(t *testing.T) {
	for _, value := range []string{"", "short", strings.Repeat("a", 257), strings.Repeat("a", 32) + " ", strings.Repeat("a", 32) + "\n"} {
		if ValidDemoCredential(value) {
			t.Error("invalid demo credential was accepted")
		}
	}
	if !ValidDemoCredential(testCredential) {
		t.Error("synthetic test credential should be accepted")
	}
}

func TestEveryAPIRouteRequiresAuthorization(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/vault"}, {"POST", "/api/vault"}, {"GET", "/api/media"},
		{"POST", "/api/media/upload-url"}, {"POST", "/api/media"},
		{"GET", "/api/media/" + testMediaID + "/download-url"}, {"DELETE", "/api/media/" + testMediaID},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			router, repo, objects := testAPI()
			response := request(router, route.method, route.path, `{}`, "")
			wantStatus(t, response, http.StatusUnauthorized)
			if response.Header().Get("WWW-Authenticate") == "" {
				t.Error("missing bearer challenge")
			}
			if repo.calls != 0 || len(objects.puts) != 0 {
				t.Error("unauthorized request reached dependencies")
			}
		})
	}
}

func TestRejectsWrongMalformedAndQueryCredentials(t *testing.T) {
	for _, header := range []string{"Bearer wrong", "Bearer " + strings.Repeat("x", 40), "Basic " + testCredential, "Bearer  " + testCredential} {
		router, repo, _ := testAPI()
		req := httptest.NewRequest("GET", "/api/vault?token="+testCredential, nil)
		req.Header.Set("Authorization", header)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		wantStatus(t, recorder, http.StatusUnauthorized)
		if repo.calls != 0 {
			t.Error("bad credential reached repository")
		}
	}
	router, _, _ := testAPI()
	wantStatus(t, request(router, "GET", "/api/vault?token="+testCredential, "", ""), http.StatusUnauthorized)
	req := httptest.NewRequest("GET", "/api/vault", nil)
	req.Header.Add("Authorization", "Bearer "+testCredential)
	req.Header.Add("Authorization", "Bearer "+testCredential)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	wantStatus(t, recorder, http.StatusUnauthorized)
}

func TestMissingConfigurationFailsClosed(t *testing.T) {
	wantStatus(t, request(NewRouter(Config{}), "GET", "/api/vault", "", testCredential), http.StatusServiceUnavailable)
	router := NewRouter(Config{DemoCredential: testCredential})
	wantStatus(t, request(router, "GET", "/api/vault", "", ""), http.StatusUnauthorized)
	wantStatus(t, request(router, "GET", "/api/vault", "", testCredential), http.StatusServiceUnavailable)
	router, repo, _ := testAPI()
	router = NewRouter(Config{DemoCredential: testCredential, Repository: repo})
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/media/upload-url"}, {"POST", "/api/media"},
		{"GET", "/api/media/" + testMediaID + "/download-url"}, {"DELETE", "/api/media/" + testMediaID},
	} {
		wantStatus(t, request(router, route.method, route.path, `{}`, testCredential), http.StatusServiceUnavailable)
	}
	if len(repo.media) != 0 {
		t.Error("unconfigured storage must not create media")
	}
}

func TestVaultCreateReadAndConflict(t *testing.T) {
	router, repo, _ := testAPI()
	repo.vault = nil
	wantStatus(t, request(router, "GET", "/api/vault", "", testCredential), http.StatusNotFound)
	wantStatus(t, request(router, "POST", "/api/vault", bodyJSON(t, apiVault()), testCredential), http.StatusCreated)
	response := request(router, "GET", "/api/vault", "", testCredential)
	wantStatus(t, response, http.StatusOK)
	var restored database.VaultConfig
	if err := json.Unmarshal(response.Body.Bytes(), &restored); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restored, apiVault()) {
		t.Error("public vault configuration did not round-trip")
	}
	wantStatus(t, request(router, "POST", "/api/vault", bodyJSON(t, apiVault()), testCredential), http.StatusConflict)
}

func TestStrictBoundedJSON(t *testing.T) {
	for name, body := range map[string]string{
		"plaintext passphrase": `{"passphrase":"never accepted"}`,
		"plaintext filename":   `{"name":"never accepted.jpg"}`,
		"trailing JSON":        bodyJSON(t, apiVault()) + `{}`,
		"malformed JSON":       `{`, "null": `null`,
	} {
		t.Run(name, func(t *testing.T) {
			router, _, _ := testAPI()
			wantStatus(t, request(router, "POST", "/api/vault", body, testCredential), http.StatusBadRequest)
		})
	}
	router, _, _ := testAPI()
	large := `{"verifier":"` + strings.Repeat("A", maxJSONBytes+1) + `"}`
	wantStatus(t, request(router, "POST", "/api/vault", large, testCredential), http.StatusRequestEntityTooLarge)
	req := httptest.NewRequest("POST", "/api/vault", strings.NewReader(bodyJSON(t, apiVault())))
	req.Header.Set("Authorization", "Bearer "+testCredential)
	req.Header.Set("Content-Type", "text/plain")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	wantStatus(t, recorder, http.StatusUnsupportedMediaType)
}

func TestListLimitsAndSanitizedFailures(t *testing.T) {
	router, repo, _ := testAPI()
	response := request(router, "GET", "/api/media", "", testCredential)
	wantStatus(t, response, http.StatusOK)
	if strings.TrimSpace(response.Body.String()) != `{"media":[]}` {
		t.Error("empty listing must be an array")
	}
	for _, limit := range []string{"0", "101", "-1", "invalid"} {
		wantStatus(t, request(router, "GET", "/api/media?limit="+limit, "", testCredential), http.StatusBadRequest)
	}
	repo.failure = errors.New("sensitive connection details must never leave the server")
	response = request(router, "GET", "/api/media", "", testCredential)
	wantStatus(t, response, http.StatusServiceUnavailable)
	if strings.Contains(response.Body.String(), "sensitive") {
		t.Error("driver details leaked")
	}
}

func TestUploadIntentGeneratesScopedRandomKeys(t *testing.T) {
	router, repo, objects := testAPI()
	response := request(router, "POST", "/api/media/upload-url", bodyJSON(t, apiIntent()), testCredential)
	wantStatus(t, response, http.StatusCreated)
	media := repo.media[testMediaID]
	if err := media.ValidatePending(); err != nil {
		t.Fatal("invalid generated media record")
	}
	if media.OriginalKey == media.ID || media.OriginalKey == media.ThumbnailKey || len(objects.puts) != 2 {
		t.Fatal("expected two independent server-generated object keys")
	}
	if objects.puts[0] != (signedPut{media.OriginalKey, media.OriginalSize}) || objects.puts[1] != (signedPut{media.ThumbnailKey, media.ThumbnailSize}) {
		t.Error("presigned PUT scope did not match expected ciphertext size/key")
	}
	wantStatus(t, request(router, "GET", "/api/media/"+testMediaID+"/download-url", "", testCredential), http.StatusNotFound)
	if len(objects.gets) != 0 {
		t.Error("pending media must not be downloadable")
	}
}

func TestUploadRejectsArbitraryKeysAndInvalidLimits(t *testing.T) {
	router, repo, objects := testAPI()
	for name, alter := range map[string]func(*uploadIntent){
		"invalid ID":    func(v *uploadIntent) { v.ID = "photo.jpg" },
		"size limit":    func(v *uploadIntent) { v.OriginalSize = database.MaxOriginalSize + 1 },
		"plaintext key": func(v *uploadIntent) { v.WrappedKey = make([]byte, 32) },
		"version":       func(v *uploadIntent) { v.Version = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			intent := apiIntent()
			alter(&intent)
			wantStatus(t, request(router, "POST", "/api/media/upload-url", bodyJSON(t, intent), testCredential), http.StatusBadRequest)
		})
	}
	wantStatus(t, request(router, "POST", "/api/media/upload-url", `{"originalKey":"another-vault/key"}`, testCredential), http.StatusBadRequest)
	if len(repo.media) != 0 || len(objects.puts) != 0 {
		t.Error("invalid upload must not create records or presigned URLs")
	}
}

func TestSigningFailureDoesNotCreatePendingRecord(t *testing.T) {
	router, repo, objects := testAPI()
	objects.failPut = 2
	response := request(router, "POST", "/api/media/upload-url", bodyJSON(t, apiIntent()), testCredential)
	wantStatus(t, response, http.StatusServiceUnavailable)
	if len(repo.media) != 0 || strings.Contains(response.Body.String(), "https://") {
		t.Error("failed signing exposed an upload URL or pending record")
	}
}

func TestConfirmRequiresBothUploadedObjectsWithExpectedSizeAndType(t *testing.T) {
	router, repo, objects := testAPI()
	wantStatus(t, request(router, "POST", "/api/media/upload-url", bodyJSON(t, apiIntent()), testCredential), http.StatusCreated)
	media := repo.media[testMediaID]
	body := `{"id":"` + testMediaID + `"}`
	wantStatus(t, request(router, "POST", "/api/media", body, testCredential), http.StatusConflict)
	objects.objects[media.OriginalKey] = storage.ObjectInfo{Size: media.OriginalSize, ContentType: storage.CiphertextContentType}
	wantStatus(t, request(router, "POST", "/api/media", body, testCredential), http.StatusConflict)
	objects.objects[media.ThumbnailKey] = storage.ObjectInfo{Size: media.ThumbnailSize + 1, ContentType: storage.CiphertextContentType}
	wantStatus(t, request(router, "POST", "/api/media", body, testCredential), http.StatusConflict)
	objects.objects[media.ThumbnailKey] = storage.ObjectInfo{Size: media.ThumbnailSize, ContentType: "image/png"}
	wantStatus(t, request(router, "POST", "/api/media", body, testCredential), http.StatusConflict)
	if repo.media[testMediaID].Status != "pending" {
		t.Fatal("unverified media was committed")
	}
	objects.headError = storage.ErrUnavailable
	wantStatus(t, request(router, "POST", "/api/media", body, testCredential), http.StatusServiceUnavailable)
	objects.headError = nil
	objects.objects[media.ThumbnailKey] = storage.ObjectInfo{Size: media.ThumbnailSize, ContentType: storage.CiphertextContentType}
	for i := 0; i < 2; i++ {
		wantStatus(t, request(router, "POST", "/api/media", body, testCredential), http.StatusOK)
	}
	if repo.media[testMediaID].Status != "ready" {
		t.Error("verified media was not committed")
	}
}

func TestDownloadSigningUsesOnlyOwnedReadyRecord(t *testing.T) {
	router, repo, objects := testAPI()
	wantStatus(t, request(router, "POST", "/api/media/upload-url", bodyJSON(t, apiIntent()), testCredential), http.StatusCreated)
	media := repo.media[testMediaID]
	media.Status = "ready"
	repo.media[testMediaID] = media
	path := "/api/media/" + testMediaID + "/download-url"
	wantStatus(t, request(router, "GET", path+"?key=arbitrary-key", "", testCredential), http.StatusOK)
	wantStatus(t, request(router, "GET", path+"?variant=thumbnail", "", testCredential), http.StatusOK)
	if !reflect.DeepEqual(objects.gets, []string{media.OriginalKey, media.ThumbnailKey}) {
		t.Error("download signed an unowned key")
	}
	wantStatus(t, request(router, "GET", path+"?variant=video", "", testCredential), http.StatusBadRequest)
	media.VaultID = "55555555-5555-4555-8555-555555555555"
	repo.media[testMediaID] = media
	wantStatus(t, request(router, "GET", path, "", testCredential), http.StatusNotFound)
	if len(objects.gets) != 2 {
		t.Error("cross-vault media was signed")
	}
}

func TestDeleteKeepsIndexOnPartialFailureAndCanRetry(t *testing.T) {
	router, repo, objects := testAPI()
	wantStatus(t, request(router, "POST", "/api/media/upload-url", bodyJSON(t, apiIntent()), testCredential), http.StatusCreated)
	media := repo.media[testMediaID]
	objects.deleteErrorKey = media.ThumbnailKey
	path := "/api/media/" + testMediaID
	wantStatus(t, request(router, "DELETE", path, "", testCredential), http.StatusServiceUnavailable)
	if len(repo.media) != 1 {
		t.Fatal("partial object deletion must not discard the index")
	}
	objects.deleteErrorKey = ""
	wantStatus(t, request(router, "DELETE", path, "", testCredential), http.StatusNoContent)
	wantStatus(t, request(router, "DELETE", path, "", testCredential), http.StatusNoContent)
	if len(repo.media) != 0 {
		t.Error("successful deletion left an indexed record")
	}
}
