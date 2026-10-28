package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/aws/smithy-go/logging"
)

const testObjectID = "11111111-1111-4111-8111-111111111111"

type rejectNetwork struct{ calls atomic.Int32 }

func (client *rejectNetwork) Do(*http.Request) (*http.Response, error) {
	client.calls.Add(1)
	return nil, errors.New("network is forbidden in this presigning test")
}

func TestS3DefaultAWSURLPresigningDoesNotContactAWS(t *testing.T) {
	network := &rejectNetwork{}
	config := aws.Config{
		Region: "us-east-1", HTTPClient: network, Logger: logging.Nop{},
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: "TESTACCESSKEY", SecretAccessKey: "test-only-not-an-aws-secret"}, nil
		}),
	}
	store := newS3(s3.NewFromConfig(config), "imageinary-test-bucket")
	signed, err := store.SignPut(context.Background(), testObjectID, 64)
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(signed.URL)
	if parsed.Scheme != "https" || !strings.HasPrefix(parsed.Host, "imageinary-test-bucket.s3.") ||
		!strings.HasSuffix(parsed.Host, ".amazonaws.com") || parsed.Path != "/ciphertext/"+testObjectID {
		t.Error("unexpected AWS endpoint scope")
	}
	if network.calls.Load() != 0 {
		t.Error("presigning must not call AWS")
	}
}

func sdkTestStore(server *httptest.Server) (*S3, *atomic.Int32) {
	count := &atomic.Int32{}
	credentials := aws.CredentialsProviderFunc(func(ctx context.Context) (aws.Credentials, error) {
		count.Add(1)
		if err := ctx.Err(); err != nil {
			return aws.Credentials{}, err
		}
		// Synthetic credentials used only against test endpoints, never AWS.
		return aws.Credentials{AccessKeyID: "TESTACCESSKEY", SecretAccessKey: "test-only-signing-secret-not-an-aws-key", SessionToken: "test-session"}, nil
	})
	endpoint := "https://objects.example"
	var client aws.HTTPClient = &http.Client{}
	if server != nil {
		endpoint, client = server.URL, server.Client()
	}
	config := aws.Config{Region: "us-east-1", Credentials: credentials, HTTPClient: client, Logger: logging.Nop{}}
	sdk := s3.NewFromConfig(config, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(endpoint)
		options.UsePathStyle = true
		options.RetryMaxAttempts = 1
		options.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
	})
	return newS3(sdk, "imageinary-test-bucket"), count
}

func TestS3PutSignatureScopeAndBrowserHeaders(t *testing.T) {
	store, _ := sdkTestStore(nil)
	signed, err := store.SignPut(context.Background(), testObjectID, 1024)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(signed.URL)
	if err != nil {
		t.Fatal("invalid signed URL")
	}
	if parsed.Scheme != "https" || parsed.Path != "/imageinary-test-bucket/ciphertext/"+testObjectID {
		t.Error("wrong signed object scope")
	}
	query := parsed.Query()
	if query.Get("X-Amz-Expires") != "180" || query.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" || query.Get("X-Amz-Signature") == "" {
		t.Error("expected a short-lived SigV4 URL")
	}
	for _, required := range []string{"content-length", "content-type", "host"} {
		if !strings.Contains(query.Get("X-Amz-SignedHeaders"), required) {
			t.Errorf("signature must bind %s; signed headers: %s", required, query.Get("X-Amz-SignedHeaders"))
		}
	}
	if signed.Headers["Content-Type"] != CiphertextContentType {
		t.Error("browser must upload generic ciphertext")
	}
	for name := range signed.Headers {
		if strings.EqualFold(name, "host") || strings.EqualFold(name, "content-length") {
			t.Error("forbidden browser header returned")
		}
	}
	if signed.Headers["X-Amz-Server-Side-Encryption"] != "AES256" && query.Get("X-Amz-Server-Side-Encryption") != "AES256" && query.Get("x-amz-server-side-encryption") != "AES256" {
		t.Error("expected additional S3 server-side encryption of ciphertext")
	}
	if signed.ExpiresAt.Before(time.Now().Add(178*time.Second)) || signed.ExpiresAt.After(time.Now().Add(181*time.Second)) {
		t.Error("unexpected URL expiration")
	}
	if query.Get("X-Amz-Security-Token") != "test-session" {
		t.Error("temporary instance-role session token must be preserved")
	}
}

func TestS3GetSignatureUsesOpaqueDownload(t *testing.T) {
	store, _ := sdkTestStore(nil)
	signed, err := store.SignGet(context.Background(), testObjectID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(signed.URL)
	if parsed.Path != "/imageinary-test-bucket/ciphertext/"+testObjectID || parsed.Query().Get("response-content-type") != CiphertextContentType ||
		parsed.Query().Get("response-content-disposition") != "attachment" {
		t.Error("download must be scoped opaque ciphertext")
	}
	if parsed.Query().Get("X-Amz-Expires") != "180" {
		t.Error("download URL is not short-lived")
	}
}

func TestS3RejectsInvalidKeysAndSizesBeforeCredentialAccess(t *testing.T) {
	store, credentials := sdkTestStore(nil)
	for _, key := range []string{"", "photo.jpg", "../another-vault/key", "ciphertext/" + testObjectID, "https://other.example/key", strings.ToUpper("abcdefab-1111-4111-8111-111111111111")} {
		if _, err := store.SignPut(context.Background(), key, 1024); !errors.Is(err, ErrInvalidRequest) {
			t.Error("invalid PUT key accepted")
		}
		if _, err := store.SignGet(context.Background(), key); !errors.Is(err, ErrInvalidRequest) {
			t.Error("invalid GET key accepted")
		}
		if _, err := store.Head(context.Background(), key); !errors.Is(err, ErrInvalidRequest) {
			t.Error("invalid HEAD key accepted")
		}
		if err := store.Delete(context.Background(), key); !errors.Is(err, ErrInvalidRequest) {
			t.Error("invalid DELETE key accepted")
		}
	}
	for _, size := range []int64{-1, 0, 29, maxCiphertextSize + 1} {
		if _, err := store.SignPut(context.Background(), testObjectID, size); !errors.Is(err, ErrInvalidRequest) {
			t.Error("invalid ciphertext size accepted")
		}
	}
	if credentials.Load() != 0 {
		t.Error("invalid requests must not access credentials or AWS")
	}
}

func TestS3ConfigurationValidation(t *testing.T) {
	for _, test := range []struct{ bucket, region string }{
		{"", "us-east-1"}, {"ab", "us-east-1"}, {"bucket.with.dots", "us-east-1"},
		{"UPPERCASE", "us-east-1"}, {"xn--reserved-bucket", "us-east-1"},
		{"bucket--x-s3", "us-east-1"}, {"valid-bucket", ""}, {"valid-bucket", "https://wrong.example"},
	} {
		if _, err := NewS3(context.Background(), test.bucket, test.region); !errors.Is(err, ErrInvalidRequest) {
			t.Error("invalid S3 configuration accepted")
		}
	}
}

func TestS3HeadAndDeleteHTTPBehavior(t *testing.T) {
	for _, code := range []int{200, 404, 403, 500} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/imageinary-test-bucket/ciphertext/"+testObjectID {
					t.Error("request escaped ciphertext scope")
				}
				if r.Header.Get("Authorization") == "" {
					t.Error("server storage operation must be signed")
				}
				if r.Method != "HEAD" && r.Method != "DELETE" {
					t.Error("unexpected server operation")
				}
				if code == 200 && r.Method == "HEAD" {
					w.Header().Set("Content-Length", "1024")
					w.Header().Set("Content-Type", CiphertextContentType)
				}
				w.WriteHeader(code)
			}))
			defer server.Close()
			store, _ := sdkTestStore(server)
			info, err := store.Head(context.Background(), testObjectID)
			switch code {
			case 200:
				if err != nil || info.Size != 1024 || info.ContentType != CiphertextContentType {
					t.Error("HEAD metadata did not round-trip")
				}
			case 404:
				if !errors.Is(err, ErrNotFound) {
					t.Error("missing object must be reported")
				}
			default:
				if !errors.Is(err, ErrUnavailable) {
					t.Error("storage failure must be sanitized")
				}
			}
			err = store.Delete(context.Background(), testObjectID)
			if code == 200 || code == 404 {
				if err != nil {
					t.Error("DELETE must be idempotent")
				}
			} else if !errors.Is(err, ErrUnavailable) {
				t.Error("DELETE failure must be reported")
			}
		})
	}
}

func TestS3LocalTransportRoundTrip(t *testing.T) {
	// This TLS fake verifies SDK transport and required headers, not AWS signature
	// enforcement, browser CORS, IAM, or bucket privacy. Those require real S3.
	var stored []byte
	var mutex sync.Mutex
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		if r.URL.Path != "/imageinary-test-bucket/ciphertext/"+testObjectID {
			t.Error("unexpected object path")
		}
		switch r.Method {
		case "PUT":
			if r.Header.Get("Content-Type") != CiphertextContentType || r.ContentLength != 64 {
				t.Error("PUT type/length mismatch")
			}
			stored, _ = io.ReadAll(r.Body)
			w.WriteHeader(200)
		case "GET":
			w.Header().Set("Content-Type", CiphertextContentType)
			_, _ = w.Write(stored)
		case "HEAD":
			if stored == nil {
				w.WriteHeader(404)
				return
			}
			w.Header().Set("Content-Type", CiphertextContentType)
			w.Header().Set("Content-Length", "64")
		case "DELETE":
			stored = nil
			w.WriteHeader(204)
		default:
			w.WriteHeader(405)
		}
	}))
	defer server.Close()
	store, _ := sdkTestStore(server)
	opaqueBytes := bytes.Repeat([]byte{42}, 64) // Synthetic opaque bytes, not a user photo.
	put, err := store.SignPut(context.Background(), testObjectID, int64(len(opaqueBytes)))
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("PUT", put.URL, bytes.NewReader(opaqueBytes))
	for name, value := range put.Headers {
		req.Header.Set(name, value)
	}
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal("local direct PUT failed")
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("local direct PUT returned an error")
	}
	if info, err := store.Head(context.Background(), testObjectID); err != nil || info.Size != 64 {
		t.Fatal("uploaded object could not be verified")
	}
	get, err := store.SignGet(context.Background(), testObjectID)
	if err != nil {
		t.Fatal(err)
	}
	response, err = server.Client().Get(get.URL)
	if err != nil {
		t.Fatal("local direct GET failed")
	}
	downloaded, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || !bytes.Equal(downloaded, opaqueBytes) {
		t.Error("opaque bytes changed in transfer")
	}
	if err := store.Delete(context.Background(), testObjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Head(context.Background(), testObjectID); !errors.Is(err, ErrNotFound) {
		t.Error("deleted object remained")
	}
}

func TestS3ErrorsAndInsecureSignedURLsAreSanitized(t *testing.T) {
	for _, err := range []error{errors.New("credential details and signed URL"), &smithy.GenericAPIError{Code: "NoSuchBucket"}, &smithy.GenericAPIError{Code: "AccessDenied"}} {
		if classifyS3(err) != ErrUnavailable {
			t.Error("unexpected error disclosure")
		}
	}
	for _, raw := range []string{"http://objects.example/key", "https://user:password@objects.example/key", "not-a-url"} {
		if _, err := browserURL(&v4.PresignedHTTPRequest{URL: raw}); !errors.Is(err, ErrUnavailable) {
			t.Error("insecure signed URL accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store, _ := sdkTestStore(nil)
	if _, err := store.SignPut(ctx, testObjectID, 64); !errors.Is(err, ErrUnavailable) {
		t.Error("credential failure must be sanitized")
	}
}
