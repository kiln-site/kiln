package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func relay(t *testing.T, status int) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/health" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		response.WriteHeader(status)
	}))
	t.Cleanup(server.Close)
	_, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestHealthyRelayPasses(t *testing.T) {
	t.Setenv("KILN_RELAY_HEALTH_PORT", relay(t, http.StatusNoContent))
	if err := check(); err != nil {
		t.Fatalf("check() = %v, want nil", err)
	}
}

// The Relay trims the variable before parsing it, so the checker must too.
func TestPortWithSurroundingWhitespacePasses(t *testing.T) {
	t.Setenv("KILN_RELAY_HEALTH_PORT", " "+relay(t, http.StatusNoContent)+"\t")
	if err := check(); err != nil {
		t.Fatalf("check() = %v, want nil", err)
	}
}

func TestUnexpectedStatusFails(t *testing.T) {
	t.Setenv("KILN_RELAY_HEALTH_PORT", relay(t, http.StatusServiceUnavailable))
	if err := check(); err == nil {
		t.Fatal("check() = nil, want an error")
	}
}
