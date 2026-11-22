package engine

import (
	"context"
	"embed"
	"encoding/json"
	"math/rand/v2"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The contract's TriageResponse examples, copied from contracts/examples (a test keeps them identical).
//
//go:embed examples/*.json
var examplesFS embed.FS

// Mock answers like the engine (MOCK_ENGINE=true) without calling it, as contracts/README.md describes:
// it picks the example matching the ticket's words and fills in the real IDs, times and masked text.
type Mock struct {
	Delay    func() time.Duration // simulated engine time; nil means no wait
	Now      func() time.Time
	examples map[string]Result
}

var mockRules = []struct {
	example string
	words   []string
}{
	{"escalate_oncall.de", []string{"vpn", "outage", "ausfall", "ausgefallen", "störung", "is down", "are down", "server down"}},
	{"human_review.en", []string{"refund", "compensation", "money back", "erstattung", "entschädigung"}},
	{"degraded.en", []string{"crash", "absturz", "abgestürzt", "stürzt"}},
}

const mockDefault = "auto_draft.en"

func NewMock() *Mock {
	m := &Mock{
		Delay:    func() time.Duration { return time.Duration(300+rand.IntN(500)) * time.Millisecond },
		Now:      time.Now,
		examples: map[string]Result{},
	}
	entries, err := examplesFS.ReadDir("examples")
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		raw, err := examplesFS.ReadFile("examples/" + e.Name())
		if err != nil {
			panic(err)
		}
		var r Result
		if err := json.Unmarshal(raw, &r); err != nil {
			panic("bad contract example " + e.Name() + ": " + err.Error())
		}
		name := strings.TrimSuffix(strings.TrimPrefix(e.Name(), "triage_response."), ".json")
		m.examples[name] = r
	}
	return m
}

func (m *Mock) Mode() string { return "mock" }

// Health reports stub components, so /api/v1/health says degraded with mode "mock", as the contract's rule
// (ok only when every component is ok) requires; the console labels it from mode.
func (m *Mock) Health(context.Context) Health { return Health{Engine: "stub", VectorDB: "stub"} }

// Example returns the name of the example the mock answers with for this text.
func Example(subject, body string) string {
	text := strings.ToLower(subject + "\n" + body)
	for _, r := range mockRules {
		for _, w := range r.words {
			if containsWord(text, w) {
				return r.example
			}
		}
	}
	return mockDefault
}

// containsWord finds w at the start of a word ("crash" matches "crashes"); phrases such as "is down" must
// also end at a word boundary, so "this download" is not an outage.
func containsWord(text, w string) bool {
	phrase := strings.Contains(w, " ")
	for from := 0; ; {
		i := strings.Index(text[from:], w)
		if i < 0 {
			return false
		}
		start, end := from+i, from+i+len(w)
		before, _ := utf8.DecodeLastRuneInString(text[:start])
		after, _ := utf8.DecodeRuneInString(text[end:])
		if (start == 0 || !unicode.IsLetter(before)) && (!phrase || end == len(text) || !unicode.IsLetter(after)) {
			return true
		}
		from = start + 1
	}
}

func (m *Mock) Triage(ctx context.Context, req Request) (Result, error) {
	if m.Delay != nil {
		select {
		case <-time.After(m.Delay()):
		case <-ctx.Done():
			return nil, &Error{Status: 499, Code: "INTERNAL", Message: "The request was cancelled.", Err: ctx.Err()}
		}
	}
	out := deepCopy(m.examples[Example(req.Subject, req.Body)])
	out["request_id"], out["ticket_id"] = req.RequestID, req.TicketID
	out["subject"], out["body"] = req.Subject, req.Body
	out["created_at"] = req.CreatedAt
	out["processed_at"] = m.Now().UTC().Format(time.RFC3339)
	// Answer as the engine would: no pii and no gateway time; the gateway adds both.
	delete(out, "pii")
	if lat, ok := out["latency_ms"].(map[string]any); ok {
		if gw, ok := lat["gateway"].(float64); ok {
			lat["total"] = lat["total"].(float64) - gw
		}
		delete(lat, "gateway")
	}
	return out, nil
}

func deepCopy(r Result) Result {
	raw, _ := json.Marshal(r)
	var out Result
	json.Unmarshal(raw, &out)
	return out
}
