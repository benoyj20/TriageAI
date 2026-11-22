package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Dogtags27/gdg-sentinal/backend/internal/engine"
	"github.com/Dogtags27/gdg-sentinal/backend/internal/ratelimit"
)

type fakeEngine struct {
	got    engine.Request
	err    error
	mode   string
	health engine.Health
}

func (f *fakeEngine) Triage(ctx context.Context, req engine.Request) (engine.Result, error) {
	f.got = req
	if f.err != nil {
		return nil, f.err
	}
	return engine.Result{
		"contract_version": "1.0", "request_id": req.RequestID, "ticket_id": req.TicketID,
		"subject": req.Subject, "body": req.Body, "gate": map[string]any{"decision": "AUTO_DRAFT"},
		"latency_ms": map[string]any{"draft": 90.0, "total": 100.0}, "warnings": []any{},
	}, nil
}

func (f *fakeEngine) Health(context.Context) engine.Health { return f.health }

func (f *fakeEngine) Mode() string {
	if f.mode == "" {
		return "live"
	}
	return f.mode
}

var reqIDPattern = regexp.MustCompile(`^req_[0-9a-f]{12}$`)

// ErrorCode in engine/app/schemas.py.
var contractCodes = map[string]bool{"INVALID_JSON": true, "VALIDATION_ERROR": true, "PAYLOAD_TOO_LARGE": true, "RATE_LIMITED": true,
	"ENGINE_UNAVAILABLE": true, "ENGINE_TIMEOUT": true, "ENGINE_BAD_RESPONSE": true, "INTERNAL": true}

func newServer(t *testing.T, eng engine.Engine) *Server {
	t.Helper()
	return &Server{Engine: eng, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), WebDir: t.TempDir(), InsightsDir: t.TempDir()}
}

func do(t *testing.T, h http.Handler, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func errField(out map[string]any, key string) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e[key].(string)
	return s
}

func TestTriageMasksPIIAndAddsGatewayFields(t *testing.T) {
	f := &fakeEngine{}
	h := newServer(t, f).Handler()
	rec, out := do(t, h, "POST", "/api/v1/triage", `{"subject":"Reset for anna@example.com","body":"I am anna@example.com, call +49 30 1234 5678"}`)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if strings.Contains(f.got.Subject+f.got.Body, "anna@") || strings.Contains(f.got.Body, "1234") {
		t.Fatalf("engine saw raw PII: %+v", f.got)
	}
	if f.got.Subject != "Reset for [EMAIL_1]" || f.got.Body != "I am [EMAIL_1], call [PHONE_1]" {
		t.Errorf("engine got %q / %q", f.got.Subject, f.got.Body)
	}
	if !reqIDPattern.MatchString(f.got.RequestID) || f.got.RequestID != rec.Header().Get("X-Request-ID") {
		t.Errorf("request_id = %q, header %q", f.got.RequestID, rec.Header().Get("X-Request-ID"))
	}
	if !regexp.MustCompile(`^LIVE-[0-9A-F]{8}$`).MatchString(f.got.TicketID) {
		t.Errorf("ticket_id = %q", f.got.TicketID)
	}
	if !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`).MatchString(f.got.CreatedAt) {
		t.Errorf("created_at = %q", f.got.CreatedAt)
	}
	masked, _ := out["pii"].(map[string]any)["masked"].([]any)
	if len(masked) != 2 || masked[0].(map[string]any)["count"] != 2.0 {
		t.Errorf("pii.masked = %v", out["pii"])
	}
	lat := out["latency_ms"].(map[string]any)
	if gw, ok := lat["gateway"].(float64); !ok || lat["total"].(float64) != 100+gw {
		t.Errorf("latency_ms = %v", lat)
	}
	if out["contract_version"] != "1.0" || out["warnings"] == nil {
		t.Errorf("engine fields should pass through: %v", out)
	}
}

func TestTriageKeepsClientTicketIDAndEmptySubject(t *testing.T) {
	f := &fakeEngine{}
	rec, out := do(t, newServer(t, f).Handler(), "POST", "/api/v1/triage", `{"subject":null,"body":"hello","ticket_id":"TKT-77","extra":1}`)
	if rec.Code != 200 || f.got.TicketID != "TKT-77" || f.got.Subject != "" || out["ticket_id"] != "TKT-77" {
		t.Errorf("%d ticket=%q subject=%q", rec.Code, f.got.TicketID, f.got.Subject)
	}
	if masked, ok := out["pii"].(map[string]any)["masked"].([]any); !ok || len(masked) != 0 {
		t.Errorf("pii.masked should be [], got %v", out["pii"])
	}
}

func TestTriageValidation(t *testing.T) {
	h := newServer(t, &fakeEngine{}).Handler()
	cases := []struct {
		name, body string
		status     int
		code       string
	}{
		{"not json", `hello`, 400, "INVALID_JSON"},
		{"not an object", `[1,2]`, 422, "VALIDATION_ERROR"},
		{"wrong type", `{"subject": 5, "body":"x"}`, 422, "VALIDATION_ERROR"},
		{"missing body", `{"subject":"only a subject"}`, 422, "VALIDATION_ERROR"},
		{"blank body", `{"body":"  \n "}`, 422, "VALIDATION_ERROR"},
		{"body too long", `{"body":"` + strings.Repeat("ä", 10_001) + `"}`, 422, "VALIDATION_ERROR"},
		{"subject too long", `{"subject":"` + strings.Repeat("a", 501) + `","body":"x"}`, 422, "VALIDATION_ERROR"},
		{"bad ticket id", `{"body":"x","ticket_id":"../etc"}`, 422, "VALIDATION_ERROR"},
		{"trailing data", `{"body":"hi"} xyz`, 400, "INVALID_JSON"},
		{"field names are case-sensitive", `{"BODY":"x"}`, 422, "VALIDATION_ERROR"},
		{"null body", `{"body":null}`, 422, "VALIDATION_ERROR"},
		{"too long once masked", `{"body":"` + strings.Repeat("x@y.de ", 1400) + `"}`, 422, "VALIDATION_ERROR"},
		{"request too large", `{"body":"` + strings.Repeat("a", 70<<10) + `"}`, 413, "PAYLOAD_TOO_LARGE"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec, out := do(t, h, "POST", "/api/v1/triage", c.body)
			if rec.Code != c.status || errField(out, "code") != c.code {
				t.Errorf("got %d %q, want %d %q (%s)", rec.Code, errField(out, "code"), c.status, c.code, rec.Body)
			}
			if !contractCodes[errField(out, "code")] {
				t.Errorf("%q is not a contract error code", errField(out, "code"))
			}
			if !reqIDPattern.MatchString(errField(out, "request_id")) || errField(out, "message") == "" {
				t.Errorf("error envelope incomplete: %s", rec.Body)
			}
		})
	}
	if rec, _ := do(t, h, "POST", "/api/v1/triage", `{"body":"`+strings.Repeat("ä", 10_000)+`"}`); rec.Code != 200 {
		t.Errorf("10,000 characters is allowed, got %d", rec.Code)
	}
}

func TestTriageEngineErrors(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{&engine.Error{Status: 504, Code: "ENGINE_TIMEOUT", Message: "slow"}, 504, "ENGINE_TIMEOUT"},
		{&engine.Error{Status: 503, Code: "ENGINE_UNAVAILABLE", Message: "down"}, 503, "ENGINE_UNAVAILABLE"},
		{&engine.Error{Status: 422, Code: "VALIDATION_ERROR", Message: "body: too long"}, 422, "VALIDATION_ERROR"},
		{io.ErrUnexpectedEOF, 500, "INTERNAL"},
	}
	for _, c := range cases {
		rec, out := do(t, newServer(t, &fakeEngine{err: c.err}).Handler(), "POST", "/api/v1/triage", `{"body":"x"}`)
		if rec.Code != c.status || errField(out, "code") != c.code || !reqIDPattern.MatchString(errField(out, "request_id")) {
			t.Errorf("%v: got %d %s", c.err, rec.Code, rec.Body)
		}
		if strings.Contains(errField(out, "message"), "EOF") {
			t.Errorf("message leaks internals: %q", errField(out, "message"))
		}
	}
}

func TestRateLimit(t *testing.T) {
	s := newServer(t, &fakeEngine{})
	s.Limiter = ratelimit.New(60, 2)
	h := s.Handler()
	for i := 0; i < 2; i++ {
		if rec, _ := do(t, h, "POST", "/api/v1/triage", `{"body":"x"}`); rec.Code != 200 {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
	}
	rec, out := do(t, h, "POST", "/api/v1/triage", `{"body":"x"}`)
	if rec.Code != 429 || errField(out, "code") != "RATE_LIMITED" || rec.Header().Get("Retry-After") == "" {
		t.Errorf("got %d %q retry-after=%q", rec.Code, errField(out, "code"), rec.Header().Get("Retry-After"))
	}
	if rec, _ := do(t, h, "GET", "/api/v1/health", ""); rec.Code != 200 {
		t.Errorf("health should not be rate limited, got %d", rec.Code)
	}
}

func TestHealth(t *testing.T) {
	cases := []struct {
		name   string
		eng    *fakeEngine
		status string
		comp   map[string]any
	}{
		{"live ok", &fakeEngine{health: engine.Health{Engine: "ok", VectorDB: "ok"}}, "ok", map[string]any{"gateway": "ok", "engine": "ok", "vector_db": "ok"}},
		{"stub stages", &fakeEngine{health: engine.Health{Engine: "stub", VectorDB: "unknown"}}, "degraded", map[string]any{"gateway": "ok", "engine": "stub", "vector_db": "unknown"}},
		{"engine down", &fakeEngine{health: engine.Health{Engine: "down", VectorDB: "unknown"}}, "down", map[string]any{"gateway": "ok", "engine": "down", "vector_db": "unknown"}},
		{"mock", &fakeEngine{mode: "mock", health: engine.Health{Engine: "stub", VectorDB: "stub"}}, "degraded", map[string]any{"gateway": "ok", "engine": "stub", "vector_db": "stub"}},
	}
	for _, c := range cases {
		rec, out := do(t, newServer(t, c.eng).Handler(), "GET", "/api/v1/health", "")
		comp, _ := out["components"].(map[string]any)
		if rec.Code != 200 || out["status"] != c.status || out["mode"] != c.eng.Mode() || out["contract_version"] != "1.0" || len(comp) != 3 {
			t.Errorf("%s: %d %v", c.name, rec.Code, out)
		}
		for k, v := range c.comp {
			if comp[k] != v {
				t.Errorf("%s: components.%s = %v, want %v", c.name, k, comp[k], v)
			}
		}
	}
}

func TestRateLimitBehindProxyUsesTheLastForwardedAddress(t *testing.T) {
	s := newServer(t, &fakeEngine{})
	s.Limiter = ratelimit.New(60, 1)
	s.TrustProxy = true
	h := s.Handler()
	send := func(fwd string) int {
		req := httptest.NewRequest("POST", "/api/v1/triage", strings.NewReader(`{"body":"x"}`))
		req.Header.Set("X-Forwarded-For", fwd)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := send("1.1.1.1, 203.0.113.7"); code != 200 {
		t.Fatalf("first request: %d", code)
	}
	if code := send("9.9.9.9, 203.0.113.7"); code != 429 {
		t.Errorf("a spoofed first entry must not give a fresh bucket, got %d", code)
	}
	if code := send("1.1.1.1, 203.0.113.8"); code != 200 {
		t.Errorf("another real client has its own bucket, got %d", code)
	}
}

func TestWrongMethod(t *testing.T) {
	h := newServer(t, &fakeEngine{}).Handler()
	for path, allow := range map[string]string{"/api/v1/triage": "POST", "/api/v1/health": "GET"} {
		method := "GET"
		if allow == "GET" {
			method = "POST"
		}
		rec, out := do(t, h, method, path, "")
		if rec.Code != 405 || rec.Header().Get("Allow") != allow || errField(out, "code") != "METHOD_NOT_ALLOWED" {
			t.Errorf("%s %s: %d %s", method, path, rec.Code, rec.Body)
		}
	}
}

func TestOldPathsAreGone(t *testing.T) {
	h := newServer(t, &fakeEngine{}).Handler()
	for _, p := range []string{"/api/triage", "/api/health"} {
		if rec, out := do(t, h, "GET", p, ""); rec.Code != 404 || !strings.Contains(errField(out, "message"), "/api/v1/") {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body)
		}
	}
}

func TestInsights(t *testing.T) {
	s := newServer(t, &fakeEngine{})
	os.WriteFile(filepath.Join(s.InsightsDir, "model_insights.json"), []byte(`{"ok":true}`), 0o644)
	os.WriteFile(filepath.Join(s.InsightsDir, "secret.json"), []byte(`{"secret":true}`), 0o644)
	h := s.Handler()
	if rec, out := do(t, h, "GET", "/api/v1/insights/model", ""); rec.Code != 200 || out["ok"] != true {
		t.Errorf("model: %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{"/api/v1/insights/operations", "/api/v1/insights/secret", "/api/v1/insights/..%2fsecret", "/api/v1/insights/"} {
		if rec, _ := do(t, h, "GET", p, ""); rec.Code != 404 {
			t.Errorf("%s: got %d, want 404", p, rec.Code)
		}
	}
}

func TestStatic(t *testing.T) {
	s := newServer(t, &fakeEngine{})
	h := s.Handler()
	if rec, out := do(t, h, "GET", "/", ""); rec.Code != 404 || errField(out, "code") != "NOT_FOUND" {
		t.Errorf("unbuilt console: %d %s", rec.Code, rec.Body)
	}
	os.WriteFile(filepath.Join(s.WebDir, "index.html"), []byte("<html>console</html>"), 0o644)
	os.MkdirAll(filepath.Join(s.WebDir, "assets"), 0o755)
	os.WriteFile(filepath.Join(s.WebDir, "assets", "app-123.js"), []byte("js"), 0o644)
	for path, want := range map[string]string{"/": "console", "/board": "console", "/assets/": "console", "/assets/app-123.js": "js"} {
		rec, _ := do(t, h, "GET", path, "")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), want) {
			t.Errorf("%s: %d %q", path, rec.Code, rec.Body)
		}
	}
	rec, _ := do(t, h, "GET", "/assets/app-123.js", "")
	if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("assets cache = %q", rec.Header().Get("Cache-Control"))
	}
	rec, _ = do(t, h, "GET", "/assets/old-chunk.js", "")
	if rec.Code != 404 || strings.Contains(rec.Body.String(), "console") || strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("missing asset: %d %q cache=%q", rec.Code, rec.Body, rec.Header().Get("Cache-Control"))
	}
}

func TestPanicIsRecovered(t *testing.T) {
	s := newServer(t, &fakeEngine{})
	h := s.middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec, out := do(t, h, "GET", "/", "")
	if rec.Code != 500 || errField(out, "code") != "INTERNAL" || !reqIDPattern.MatchString(errField(out, "request_id")) {
		t.Errorf("got %d %s", rec.Code, rec.Body)
	}
}

// The mock end to end: what the console gets in MOCK_ENGINE mode.
func TestMockModeEndToEnd(t *testing.T) {
	m := engine.NewMock()
	m.Delay = nil
	rec, out := do(t, newServer(t, m).Handler(), "POST", "/api/v1/triage", `{"subject":"VPN ausgefallen","body":"Rückruf an +49 30 1234 5678"}`)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if out["gate"].(map[string]any)["decision"] != "ESCALATE_ONCALL" || out["body"] != "Rückruf an [PHONE_1]" || out["burst"] == nil {
		t.Errorf("unexpected mock answer: %v / %v", out["gate"], out["body"])
	}
	lat := out["latency_ms"].(map[string]any)
	sum := 0.0
	for k, v := range lat {
		if k != "total" {
			sum += v.(float64)
		}
	}
	if lat["total"].(float64)+0.05 < sum {
		t.Errorf("total %v < sum of stages %v", lat["total"], sum)
	}
}
