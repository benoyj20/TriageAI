package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	triagePath = "/v1/triage"
	healthPath = "/healthz"
	maxReply   = 2 << 20
)

// Client calls the private Python engine over HTTP.
type Client struct {
	base    string
	timeout time.Duration
	http    *http.Client
}

func NewClient(baseURL string, timeout time.Duration) *Client {
	return &Client{base: baseURL, timeout: timeout, http: &http.Client{}}
}

func (c *Client) Mode() string { return "live" }

func (c *Client) Triage(ctx context.Context, req Request) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+triagePath, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	hr.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(hr)
	if err != nil {
		return nil, c.transportError(ctx, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxReply))
	if err != nil {
		return nil, c.transportError(ctx, err)
	}

	if res.StatusCode != http.StatusOK {
		// The engine's own error envelope passes through with its status (contract "Errors").
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Error.Code != "" && env.Error.Message != "" {
			return nil, &Error{Status: res.StatusCode, Code: env.Error.Code, Message: env.Error.Message}
		}
		return nil, badResponse(fmt.Errorf("status %d without an error envelope", res.StatusCode))
	}

	var out Result
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return nil, badResponse(err)
	}
	if err := looksLikeContract(out, req); err != nil {
		return nil, badResponse(err)
	}
	return out, nil
}

// looksLikeContract is a cheap shape check; the engine validates the full contract itself.
func looksLikeContract(r Result, req Request) error {
	if v, _ := r["contract_version"].(string); !strings.HasPrefix(v, "1.") {
		return errors.New("contract_version is not 1.x")
	}
	if r["request_id"] != req.RequestID || r["ticket_id"] != req.TicketID {
		return errors.New("request_id or ticket_id not echoed")
	}
	if gate, _ := r["gate"].(map[string]any); gate == nil || gate["decision"] == nil {
		return errors.New("gate.decision missing")
	}
	lat, _ := r["latency_ms"].(map[string]any)
	if _, ok := lat["total"].(float64); !ok {
		return errors.New("latency_ms.total missing")
	}
	return nil
}

func badResponse(err error) error {
	return &Error{Status: http.StatusBadGateway, Code: "ENGINE_BAD_RESPONSE", Message: "The triage engine sent a response the console can't use. Try again, or check the engine logs.", Err: err}
}

func (c *Client) Health(ctx context.Context) Health {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	down := Health{Engine: "down", VectorDB: "unknown"}
	hr, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+healthPath, nil)
	if err != nil {
		return down
	}
	res, err := c.http.Do(hr)
	if err != nil {
		return down
	}
	defer res.Body.Close()
	var body struct {
		Status     string            `json:"status"`
		Components map[string]string `json:"components"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body) != nil {
		return down
	}
	h := Health{Engine: "ok", VectorDB: body.Components["vector_db"]}
	switch body.Status {
	case "ok":
	case "down":
		h.Engine = "down"
	default:
		h.Engine = "stub"
	}
	if h.VectorDB == "" {
		h.VectorDB = "unknown"
	}
	return h
}

func (c *Client) transportError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &Error{Status: http.StatusGatewayTimeout, Code: "ENGINE_TIMEOUT", Message: fmt.Sprintf("The triage engine didn't answer within %d seconds. Try again in a moment.", int(c.timeout.Seconds())), Err: err}
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return &Error{Status: 499, Code: "INTERNAL", Message: "The request was cancelled.", Err: err}
	}
	return &Error{Status: http.StatusServiceUnavailable, Code: "ENGINE_UNAVAILABLE", Message: "The triage engine is not reachable right now. Try again in a moment.", Err: err}
}
