package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"imageinary/backend/internal/database"
	"imageinary/backend/internal/handlers"
	"imageinary/backend/internal/storage"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if err := validateDeployment(); err != nil {
		return err
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return errors.New("PORT must be a number between 1 and 65535")
	}
	config := handlers.Config{DemoCredential: os.Getenv("DEMO_API_TOKEN")}
	if config.DemoCredential != "" && !handlers.ValidDemoCredential(config.DemoCredential) {
		return errors.New("DEMO_API_TOKEN must be 32 to 256 printable ASCII characters without spaces")
	}
	if config.DemoCredential == "" {
		log.Print("Demo API credential not configured; /api routes are disabled")
	}
	bucket, region := os.Getenv("S3_BUCKET"), os.Getenv("AWS_REGION")
	if bucket != "" || region != "" {
		if bucket == "" || region == "" {
			return errors.New("configure S3_BUCKET and AWS_REGION together")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		objects, err := storage.NewS3(ctx, bucket, region)
		cancel()
		if err != nil {
			return errors.New("S3 configuration failed; check bucket, region, and AWS credential provider configuration")
		}
		config.Storage = objects
	} else {
		log.Print("S3 not configured; ciphertext transfer and deletion routes are disabled")
	}
	if connectionURL := os.Getenv("DATABASE_URL"); connectionURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		store, err := database.Open(ctx, connectionURL)
		cancel()
		if err != nil {
			return errors.New("database connection failed; check DATABASE_URL and network access")
		}
		defer store.Close()
		config.CheckDatabase = store.Ready
		config.Repository = store
	} else {
		log.Print("Database not configured; /readyz will return 503")
	}
	server := &http.Server{
		// Bind only to localhost by default; containers sit behind the HTTPS proxy.
		Addr:              net.JoinHostPort(bindHost(), port),
		Handler:           handlers.NewRouter(config),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serverError := make(chan error, 1)
	go func() {
		log.Printf("Imageinary API listening on %s (HTTPS is terminated by the proxy)", server.Addr)
		serverError <- server.ListenAndServe()
	}()
	select {
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP server failed; check local port availability")
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Print("Graceful shutdown failed: ", err)
			_ = server.Close()
		}
	}
	return nil
}

func bindHost() string {
	if host := os.Getenv("HOST"); host != "" {
		return host
	}
	return "localhost"
}

func validateDeployment() error {
	if host := bindHost(); host != "localhost" && net.ParseIP(host) == nil {
		return errors.New("HOST must be localhost or a valid IP address")
	}
	environment := os.Getenv("APP_ENV")
	if environment != "" && environment != "development" && environment != "production" {
		return errors.New("APP_ENV must be development or production")
	}
	if environment != "production" {
		return nil
	}
	if !handlers.ValidDemoCredential(os.Getenv("DEMO_API_TOKEN")) || os.Getenv("S3_BUCKET") == "" || os.Getenv("AWS_REGION") == "" {
		return errors.New("production requires the demo credential, S3_BUCKET, and AWS_REGION")
	}
	databaseURL, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || (databaseURL.Scheme != "postgres" && databaseURL.Scheme != "postgresql") || databaseURL.Hostname() == "" {
		return errors.New("production requires a PostgreSQL DATABASE_URL")
	}
	query := databaseURL.Query()
	if len(query["sslmode"]) != 1 || query.Get("sslmode") != "verify-full" || len(query["sslrootcert"]) != 1 || query.Get("sslrootcert") == "" {
		return errors.New("production PostgreSQL requires sslmode=verify-full and sslrootcert pointing to the trusted RDS CA bundle")
	}
	return nil
}
