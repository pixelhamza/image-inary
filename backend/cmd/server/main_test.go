package main

import (
	"strings"
	"testing"
)

func TestInvalidPortStopsStartup(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("HOST", "localhost")
	for _, port := range []string{"0", "65536", "not-a-port"} {
		t.Run(port, func(t *testing.T) {
			t.Setenv("PORT", port)
			if err := run(); err == nil || !strings.Contains(err.Error(), "PORT") {
				t.Error("invalid port should stop startup")
			}
		})
	}
}

func TestProductionConfigurationFailsClosed(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("HOST", "0.0.0.0")
	t.Setenv("DEMO_API_TOKEN", "synthetic-production-test-token-123456789")
	t.Setenv("S3_BUCKET", "imageinary-test-bucket")
	t.Setenv("AWS_REGION", "us-east-1")
	for _, value := range []string{"", "postgres://db.example/vault?sslmode=disable", "postgres://db.example/vault?sslmode=require", "postgres://db.example/vault?sslmode=verify-full"} {
		t.Setenv("DATABASE_URL", value)
		if err := validateDeployment(); err == nil {
			t.Error("production database TLS validation must fail closed")
		}
	}
	t.Setenv("DATABASE_URL", "postgres://db.example/vault?sslmode=verify-full&sslrootcert=/etc/ssl/certs/aws-rds-ca.pem")
	if err := validateDeployment(); err != nil {
		t.Error("complete production configuration should pass static validation")
	}
	t.Setenv("DEMO_API_TOKEN", "")
	if err := validateDeployment(); err == nil {
		t.Error("production must require the operator credential")
	}
}

func TestBindHostValidation(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("HOST", "https://not-a-bind-address")
	if err := validateDeployment(); err == nil {
		t.Error("invalid bind host must fail")
	}
	t.Setenv("HOST", "127.0.0.1")
	if err := validateDeployment(); err != nil {
		t.Error("loopback bind should be accepted")
	}
	t.Setenv("APP_ENV", "misspelled-production")
	if err := validateDeployment(); err == nil {
		t.Error("unknown environment must fail")
	}
}

func TestInvalidDemoCredentialStopsStartupBeforeDatabaseAccess(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("HOST", "localhost")
	t.Setenv("PORT", "8080")
	t.Setenv("DEMO_API_TOKEN", "short-secret")
	t.Setenv("DATABASE_URL", "invalid")
	err := run()
	if err == nil || !strings.Contains(err.Error(), "DEMO_API_TOKEN") || strings.Contains(err.Error(), "short-secret") {
		t.Error("invalid demo credential should fail without exposing its value")
	}
}

func TestDatabaseStartupErrorsDoNotExposeConnectionDetails(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("HOST", "localhost")
	t.Setenv("PORT", "8080")
	t.Setenv("DEMO_API_TOKEN", "")
	t.Setenv("S3_BUCKET", "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("DATABASE_URL", "postgres://user:private-test-value@localhost:bad-port/db")
	err := run()
	if err == nil || strings.Contains(err.Error(), "private-test-value") || strings.Contains(err.Error(), "postgres://") {
		t.Error("database startup errors must be sanitized")
	}
}

func TestS3StartupRequiresCompleteConfiguration(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("HOST", "localhost")
	for _, config := range []struct{ bucket, region string }{
		{"imageinary-test-bucket", ""}, {"", "us-east-1"}, {"invalid.bucket", "us-east-1"},
	} {
		t.Run(config.bucket+config.region, func(t *testing.T) {
			t.Setenv("PORT", "8080")
			t.Setenv("DEMO_API_TOKEN", "")
			t.Setenv("DATABASE_URL", "")
			t.Setenv("S3_BUCKET", config.bucket)
			t.Setenv("AWS_REGION", config.region)
			if err := run(); err == nil {
				t.Error("incomplete/invalid S3 configuration must fail before serving")
			}
		})
	}
}
