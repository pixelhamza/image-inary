package handlers

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"imageinary/backend/internal/database"
	"imageinary/backend/internal/storage"
)

func TestAPIWithPostgresIntegration(t *testing.T) {
	connectionURL := os.Getenv("TEST_DATABASE_URL")
	if connectionURL == "" {
		t.Skip("set TEST_DATABASE_URL to test the API against local PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, connectionURL)
	if err != nil {
		t.Fatal("cannot connect to local test database")
	}
	defer admin.Close(context.Background())
	schema := "imageinary_api_" + strings.ReplaceAll(randomID(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal("cannot create isolated API test schema")
	}
	defer func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error("cannot clean up API test schema")
		}
	}()
	parsed, err := url.Parse(connectionURL)
	if err != nil || parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	scopedURL := parsed.String()
	migration, err := os.ReadFile("../../../database/001_init.sql")
	if err != nil {
		t.Fatal("cannot read SQL migration")
	}
	connection, err := pgx.Connect(ctx, scopedURL)
	if err != nil {
		t.Fatal("cannot connect to isolated test schema")
	}
	_, migrationErr := connection.Exec(ctx, string(migration))
	_ = connection.Close(ctx)
	if migrationErr != nil {
		t.Fatal("API integration migration failed")
	}
	repo, err := database.Open(ctx, scopedURL)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	objects := &fakeStorage{objects: make(map[string]storage.ObjectInfo)}
	router := NewRouter(Config{DemoCredential: testCredential, Repository: repo, Storage: objects, CheckDatabase: repo.Ready})
	wantStatus(t, request(router, "GET", "/api/vault", "", ""), 401)
	wantStatus(t, request(router, "GET", "/api/vault", "", testCredential), 404)
	wantStatus(t, request(router, "POST", "/api/vault", bodyJSON(t, apiVault()), testCredential), 201)
	wantStatus(t, request(router, "POST", "/api/vault", bodyJSON(t, apiVault()), testCredential), 409)
	wantStatus(t, request(router, "POST", "/api/media/upload-url", bodyJSON(t, apiIntent()), testCredential), 201)
	pending := request(router, "GET", "/api/media", "", testCredential)
	wantStatus(t, pending, 200)
	if strings.TrimSpace(pending.Body.String()) != `{"media":[]}` {
		t.Fatal("pending uploads must not be listed")
	}
	for _, object := range objects.puts {
		objects.objects[object.key] = storage.ObjectInfo{Size: object.size, ContentType: storage.CiphertextContentType}
	}
	wantStatus(t, request(router, "POST", "/api/media", `{"id":"`+testMediaID+`"}`, testCredential), 200)
	response := request(router, "GET", "/api/media", "", testCredential)
	wantStatus(t, response, 200)
	var listing struct {
		Media []database.Media `json:"media"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Media) != 1 || !reflect.DeepEqual(listing.Media[0].WrappedKey, apiIntent().WrappedKey) ||
		!reflect.DeepEqual(listing.Media[0].EncryptedMetadata, apiIntent().Metadata) {
		t.Fatal("API did not retain encrypted key/metadata fields")
	}
	wantStatus(t, request(router, "GET", "/api/media/"+testMediaID+"/download-url?variant=thumbnail", "", testCredential), 200)
	wantStatus(t, request(router, "DELETE", "/api/media/"+testMediaID, "", testCredential), 204)
	wantStatus(t, request(router, "DELETE", "/api/media/"+testMediaID, "", testCredential), 204)
	t.Log("authenticated API lifecycle passed against real PostgreSQL with fake object storage (not S3)")
}
