package handlers

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// Demo-only access control, not a production account/session system. The
// operator supplies a high-entropy credential, separately from the vault password.
func ValidDemoCredential(value string) bool {
	if len(value) < 32 || len(value) > 256 {
		return false
	}
	for _, character := range value {
		if character <= 32 || character >= 127 {
			return false
		}
	}
	return true
}

func authenticate(credential string) func(http.Handler) http.Handler {
	configured := ValidDemoCredential(credential)
	expected := sha256.Sum256([]byte(credential))
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !configured {
				writeError(w, http.StatusServiceUnavailable, "api_not_configured")
				return
			}
			scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
			actual := sha256.Sum256([]byte(token))
			if len(r.Header.Values("Authorization")) != 1 || !ok || !strings.EqualFold(scheme, "Bearer") ||
				!ValidDemoCredential(token) || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
				w.Header().Set("WWW-Authenticate", `Bearer realm="Imageinary demo"`)
				writeError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
