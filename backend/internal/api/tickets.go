package api

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// Ticket store routes, proxied to the engine (which keeps triaged tickets in Redis for 7 days):
//
//	GET /api/v1/tickets                 incident managers: recent tickets (full triage results)
//	GET /api/v1/tickets/{id}            ticket creators: their own words, language, status and dates (no analytics)
//	GET /api/v1/tickets/{id}/status     ticket creators: minimal status of their own ticket
//	GET /api/v1/tickets/{id}/related    ticket creators: similar solved tickets, translated into their language
//	PUT /api/v1/tickets/{id}/status     incident managers: move a ticket (new/escalated/review/drafted/resolved)
//
// The engine owns the data and the rules; the gateway only checks the id and forwards.
func (s *Server) ticketRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/tickets", s.ticketsProxy)
	mux.HandleFunc("GET /api/v1/tickets/{id}", s.ticketsProxy)
	mux.HandleFunc("GET /api/v1/tickets/{id}/status", s.ticketsProxy)
	mux.HandleFunc("GET /api/v1/tickets/{id}/related", s.ticketsProxy)
	mux.HandleFunc("PUT /api/v1/tickets/{id}/status", s.ticketsProxy)
}

func (s *Server) ticketsProxy(w http.ResponseWriter, r *http.Request) {
	if s.EngineURL == "" {
		writeError(w, r, http.StatusServiceUnavailable, "ENGINE_UNAVAILABLE", "The ticket store needs the live engine (MOCK_ENGINE=false).")
		return
	}
	if id := r.PathValue("id"); id != "" && !clientTicketID.MatchString(id) {
		writeError(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "ticket id: use letters, digits and _ . : - only.")
		return
	}
	target, err := url.Parse(s.EngineURL)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "INTERNAL", "The engine URL is not valid.")
		return
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = strings.TrimSuffix(target.Path, "/") + strings.TrimPrefix(r.URL.Path, "/api")
			pr.Out.URL.RawPath = ""
			pr.Out.Header.Set("X-Request-ID", requestID(r))
		},
		Transport: &http.Transport{ResponseHeaderTimeout: proxyTimeout(r.URL.Path)},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeError(w, r, http.StatusServiceUnavailable, "ENGINE_UNAVAILABLE", "The ticket store is not reachable. Try again in a moment.")
		},
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	proxy.ServeHTTP(w, r)
}

// Related readings may wait for one LLM translation (OpenAI, then Gemini: about 10 s each at worst).
// Kept under the server's write timeout (engine timeout + 10 s).
func proxyTimeout(path string) time.Duration {
	if strings.HasSuffix(path, "/related") {
		return 21 * time.Second
	}
	return 10 * time.Second
}
