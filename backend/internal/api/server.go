// Package api is the gateway's HTTP surface (contracts/README.md v1): the console talks only to these routes.
package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Dogtags27/gdg-sentinal/backend/internal/engine"
	"github.com/Dogtags27/gdg-sentinal/backend/internal/pii"
	"github.com/Dogtags27/gdg-sentinal/backend/internal/ratelimit"
)

const (
	contractVersion = "1.0"
	maxRequestBytes = 64 << 10
	maxSubjectRunes = 500
	maxBodyRunes    = 10_000
	// Placeholders can lengthen the text; the engine accepts up to these (engine/app/schemas.py).
	maxMaskedSubjectRunes = 700
	maxMaskedBodyRunes    = 12_000
)

var clientTicketID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`)

// Insights files the console may request; anything else is a 404, so no path ever reaches the disk.
var insightsFiles = map[string]string{
	"operations": "operations_insights.json",
	"model":      "model_insights.json",
}

type Server struct {
	Engine      engine.Engine
	Limiter     *ratelimit.Limiter
	WebDir      string
	InsightsDir string
	TrustProxy  bool
	Log         *slog.Logger
	// EngineURL is the Python engine base URL for the ticket store routes; empty in mock mode.
	EngineURL string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("POST /api/v1/triage", s.triage)
	mux.HandleFunc("GET /api/v1/insights/{name}", s.insights)
	s.ticketRoutes(mux)
	// NOT_FOUND and METHOD_NOT_ALLOWED are outside the contract's error codes; the console never gets them.
	mux.HandleFunc("/api/v1/triage", methodNotAllowed("POST"))
	mux.HandleFunc("/api/v1/health", methodNotAllowed("GET"))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "No such API route. The console uses /api/v1/triage and /api/v1/health.")
	})
	mux.Handle("/", s.static())
	return s.middleware(mux)
}

// health always answers 200 so the console can render it.
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	h := s.Engine.Health(r.Context())
	status := "degraded"
	switch {
	case h.Engine == "down":
		status = "down"
	case h.Engine == "ok" && h.VectorDB == "ok":
		status = "ok"
	}
	components := map[string]string{"gateway": "ok", "engine": h.Engine, "vector_db": h.VectorDB}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": status, "mode": s.Engine.Mode(), "contract_version": contractVersion, "components": components,
	})
}

type triageRequest struct {
	Subject  *string `json:"subject"`
	Body     *string `json:"body"`
	TicketID *string `json:"ticket_id"`
}

func (s *Server) triage(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	if ok, wait := s.Limiter.Allow(s.clientIP(r)); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, r, http.StatusTooManyRequests, "RATE_LIMITED", "Too many triage requests from this computer. Wait a moment and try again.")
		return
	}

	in, status, code, msg := decodeTriage(w, r)
	if code != "" {
		writeError(w, r, status, code, msg)
		return
	}

	// PII never leaves the gateway: the engine, its logs and the LLM only see the masked text.
	masker := pii.NewMasker()
	req := engine.Request{
		RequestID: requestID(r),
		TicketID:  in.ticketID,
		Subject:   masker.Mask(in.subject),
		Body:      masker.Mask(in.body),
		CreatedAt: start.UTC().Format(time.RFC3339),
	}
	if req.TicketID == "" {
		req.TicketID = "LIVE-" + strings.ToUpper(randomHex(4))
	}
	if utf8.RuneCountInString(req.Subject) > maxMaskedSubjectRunes || utf8.RuneCountInString(req.Body) > maxMaskedBodyRunes {
		writeError(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "The ticket holds so many email addresses, phone numbers or other personal details that it is too long once they are masked. Shorten it and try again.")
		return
	}

	engineStart := time.Now()
	res, err := s.Engine.Triage(r.Context(), req)
	engineTime := time.Since(engineStart)
	if err != nil {
		s.engineError(w, r, err)
		return
	}

	res["pii"] = map[string]any{"masked": masker.Entities()}
	lat := res["latency_ms"].(map[string]any)
	gatewayMS := round1(float64(time.Since(start)-engineTime) / float64(time.Millisecond))
	lat["gateway"] = gatewayMS
	lat["total"] = round1(lat["total"].(float64) + gatewayMS)
	writeJSON(w, http.StatusOK, res)
}

type ticketInput struct{ subject, body, ticketID string }

// decodeTriage applies the request rules of contracts/README.md and returns the error to send, if any.
// Field names match exactly (encoding/json alone would also accept "BODY"); unknown fields are ignored.
func decodeTriage(w http.ResponseWriter, r *http.Request) (ticketInput, int, string, string) {
	invalid := func(msg string) (ticketInput, int, string, string) {
		return ticketInput{}, http.StatusUnprocessableEntity, "VALIDATION_ERROR", msg
	}
	var fields map[string]json.RawMessage
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	err := dec.Decode(&fields)
	if err == nil && dec.More() {
		err = errors.New("trailing data after the JSON object")
	}
	if err != nil {
		var tooBig *http.MaxBytesError
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &tooBig):
			return ticketInput{}, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "The ticket is too large. Keep the request under 64 KB."
		case errors.As(err, &typeErr):
			return invalid(`Send a JSON object like {"subject": "...", "body": "..."}.`)
		default:
			return ticketInput{}, http.StatusBadRequest, "INVALID_JSON", `The request is not valid JSON. Send {"subject": "...", "body": "..."}.`
		}
	}
	if fields == nil {
		return invalid(`Send a JSON object like {"subject": "...", "body": "..."}.`)
	}
	str := func(name string) (*string, bool) {
		raw, ok := fields[name]
		if !ok || string(raw) == "null" {
			return nil, true
		}
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return nil, false
		}
		return &v, true
	}
	var in triageRequest
	var ok bool
	if in.Subject, ok = str("subject"); !ok {
		return invalid("subject: must be a string or null.")
	}
	if in.Body, ok = str("body"); !ok {
		return invalid("body: must be a string.")
	}
	if in.TicketID, ok = str("ticket_id"); !ok {
		return invalid("ticket_id: must be a string.")
	}
	out := ticketInput{}
	if in.Subject != nil {
		out.subject = *in.Subject
	}
	if in.Body != nil {
		out.body = *in.Body
	}
	if in.TicketID != nil {
		out.ticketID = *in.TicketID
	}
	switch {
	case strings.TrimSpace(out.body) == "" || utf8.RuneCountInString(out.body) > maxBodyRunes:
		return invalid("body: must be 1 to 10,000 characters and not only whitespace.")
	case utf8.RuneCountInString(out.subject) > maxSubjectRunes:
		return invalid("subject: must be at most 500 characters.")
	case in.TicketID != nil && !clientTicketID.MatchString(out.ticketID):
		return invalid("ticket_id: use up to 64 letters, digits and _ . : - , starting with a letter or digit.")
	}
	return out, 0, "", ""
}

func methodNotAllowed(allow string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", allow)
		writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Use "+allow+" for "+r.URL.Path+".")
	}
}

func (s *Server) engineError(w http.ResponseWriter, r *http.Request, err error) {
	if e, ok := engine.AsError(err); ok {
		if e.Status >= 500 {
			s.Log.Warn("engine error", "request_id", requestID(r), "code", e.Code, "message", e.Message, "cause", fmt.Sprint(e.Err))
		}
		writeError(w, r, e.Status, e.Code, e.Message)
		return
	}
	s.Log.Error("triage failed", "request_id", requestID(r), "err", err)
	writeError(w, r, http.StatusInternalServerError, "INTERNAL", "The gateway hit an unexpected error. Try again, and quote the request ID if it keeps happening.")
}

func (s *Server) insights(w http.ResponseWriter, r *http.Request) {
	file, ok := insightsFiles[r.PathValue("name")]
	if !ok {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "Unknown insights export. Use operations or model.")
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.InsightsDir, file))
	if err != nil {
		writeError(w, r, http.StatusNotFound, "NOT_FOUND", "That insights export has not been generated yet.")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(raw)
}

// static serves the built console. Hashed files under /assets/ are cached for a year; everything else,
// including index.html, is revalidated so a deploy shows up on the next load.
func (s *Server) static() http.Handler {
	if s.WebDir == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeError(w, r, http.StatusNotFound, "NOT_FOUND", "Static serving is off (WEB_DIR is empty).")
		})
	}
	files := http.FileServer(http.Dir(s.WebDir))
	index := filepath.Join(s.WebDir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(index); err != nil {
			writeError(w, r, http.StatusNotFound, "NOT_FOUND", "The console is not built. Run npm run build in frontend/.")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		clean := filepath.Join(s.WebDir, filepath.FromSlash(filepath.Clean("/"+r.URL.Path)))
		info, err := os.Stat(clean)
		if err != nil && strings.HasPrefix(r.URL.Path, "/assets/") {
			// A stale tab asking for an old chunk must not get index.html cached for a year.
			w.Header().Set("Cache-Control", "no-cache")
			http.NotFound(w, r)
			return
		}
		if err != nil || info.IsDir() && r.URL.Path != "/" {
			// Unknown paths get the app shell (the console routes with #/ so this is rare).
			http.ServeFile(w, r, index)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func (s *Server) clientIP(r *http.Request) string {
	if s.TrustProxy {
		// Our proxy appends the address it saw, so only the last entry is trustworthy; earlier ones come
		// from the client.
		fwd := r.Header.Values("X-Forwarded-For")
		if len(fwd) > 0 {
			parts := strings.Split(fwd[len(fwd)-1], ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError sends the contract's error envelope; the console shows message to the operator as is.
func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message, "request_id": requestID(r)}})
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func round1(x float64) float64 { return float64(int64(x*10+0.5)) / 10 }
