package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Dogtags27/gdg-sentinal/backend/internal/engine"
)

func TestTicketRoutesProxyToTheEngine(t *testing.T) {
	var gotMethod, gotPath, gotBody string
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotMethod, gotPath, gotBody = r.Method, r.URL.Path, string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer fake.Close()

	s := newServer(t, engine.NewMock())
	s.EngineURL = fake.URL
	h := s.Handler()

	cases := []struct{ method, path, body, wantPath string }{
		{"GET", "/api/v1/tickets?limit=5", "", "/v1/tickets"},
		{"GET", "/api/v1/tickets/LIVE-ABC123", "", "/v1/tickets/LIVE-ABC123"},
		{"GET", "/api/v1/tickets/LIVE-ABC123/status", "", "/v1/tickets/LIVE-ABC123/status"},
		{"GET", "/api/v1/tickets/LIVE-ABC123/related", "", "/v1/tickets/LIVE-ABC123/related"},
		{"PUT", "/api/v1/tickets/LIVE-ABC123/status", `{"status":"resolved"}`, "/v1/tickets/LIVE-ABC123/status"},
	}
	for _, c := range cases {
		rec, _ := do(t, h, c.method, c.path, c.body)
		if rec.Code != 200 || gotMethod != c.method || gotPath != c.wantPath || gotBody != c.body {
			t.Fatalf("%s %s: code=%d forwarded %s %s %q", c.method, c.path, rec.Code, gotMethod, gotPath, gotBody)
		}
	}
}

func TestTicketRoutesNeedTheLiveEngineAndAValidID(t *testing.T) {
	s := newServer(t, engine.NewMock())
	if rec, body := do(t, s.Handler(), "GET", "/api/v1/tickets", ""); rec.Code != 503 || body["error"].(map[string]any)["code"] != "ENGINE_UNAVAILABLE" {
		t.Fatalf("mock mode: %d %v", rec.Code, body)
	}
	s.EngineURL = "http://127.0.0.1:1"
	if rec, _ := do(t, s.Handler(), "GET", "/api/v1/tickets/bad%20id/status", ""); rec.Code != 422 {
		t.Fatalf("bad id: %d", rec.Code)
	}
	if rec, _ := do(t, s.Handler(), "GET", "/api/v1/tickets", ""); rec.Code != 503 {
		t.Fatalf("engine down: %d", rec.Code)
	}
}

func TestRelatedReadingsGetTheLongerTimeout(t *testing.T) {
	if proxyTimeout("/api/v1/tickets/LIVE-1/related") <= proxyTimeout("/api/v1/tickets/LIVE-1/status") {
		t.Fatal("related readings may wait for an LLM translation and need a longer timeout")
	}
}
