// Package engine is the gateway's view of the triage engine: the private Python service or the mock.
// Shapes follow contracts/README.md (v1).
package engine

import (
	"context"
	"errors"
)

// Request is the engine triage request. Subject and body are already PII-masked; subject is "" when
// the ticket has none.
type Request struct {
	RequestID string `json:"request_id"`
	TicketID  string `json:"ticket_id"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// Result is the engine's TriageResponse as a JSON object. The gateway adds pii and latency_ms.gateway and
// passes every other field through unchanged.
type Result = map[string]any

// Health is what the gateway needs from the engine's /healthz.
type Health struct {
	Engine   string // ok, stub (some stages are still stubs), down
	VectorDB string // copied from the engine: ok, down, stub, unknown
}

type Engine interface {
	Triage(ctx context.Context, req Request) (Result, error)
	Health(ctx context.Context) Health
	Mode() string // "live" or "mock", as reported by /api/v1/health
}

// Error is an engine failure the gateway turns into the contract's error envelope.
type Error struct {
	Status  int    // HTTP status the gateway returns
	Code    string // contract error code, e.g. ENGINE_TIMEOUT
	Message string // readable by an operator
	Err     error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Err }

func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}
