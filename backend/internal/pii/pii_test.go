package pii

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type tcase struct {
	Name   string   `json:"name"`
	In     string   `json:"in"`
	Out    string   `json:"out"`
	Masked []Entity `json:"masked"`
}

// testdata/cases.json is shared with frontend/tests/engine.test.js so the gateway and the browser mock agree.
func TestMaskSharedCases(t *testing.T) {
	raw, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []tcase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			out, masked := Mask(c.In)
			if out != c.Out {
				t.Errorf("Mask(%q)\n got  %q\n want %q", c.In, out, c.Out)
			}
			if len(masked) == 0 && len(c.Masked) == 0 {
				return
			}
			if !reflect.DeepEqual(masked, c.Masked) {
				t.Errorf("Mask(%q) entities = %v, want %v", c.In, masked, c.Masked)
			}
		})
	}
}

func TestMaskerSharesNumberingAcrossFields(t *testing.T) {
	m := NewMasker()
	subject := m.Mask("Reset for anna@example.com")
	body := m.Mask("Hi, I am anna@example.com, my colleague is ben@example.com. Call +49 30 1234 5678.")
	if subject != "Reset for [EMAIL_1]" {
		t.Errorf("subject = %q", subject)
	}
	if want := "Hi, I am [EMAIL_1], my colleague is [EMAIL_2]. Call [PHONE_1]."; body != want {
		t.Errorf("body = %q, want %q", body, want)
	}
	if want := []Entity{{"EMAIL", 3}, {"PHONE", 1}}; !reflect.DeepEqual(m.Entities(), want) {
		t.Errorf("entities = %v, want %v", m.Entities(), want)
	}
}

func TestEntityJSON(t *testing.T) {
	b, _ := json.Marshal(Entity{Type: "EMAIL", Count: 1})
	if string(b) != `{"type":"EMAIL","count":1}` {
		t.Errorf("JSON = %s", b)
	}
}

func TestMaskLongBodyIsFast(t *testing.T) {
	body := strings.Repeat("Hallo, Rückruf an 030 1234567 oder max@firma.de, Bestellung 123456789. ", 120) // ~8 kB
	out, masked := Mask(body)
	if strings.Contains(out, "1234567 ") || strings.Contains(out, "@") {
		t.Fatalf("unmasked PII left in output")
	}
	if want := []Entity{{"EMAIL", 120}, {"PHONE", 120}}; !reflect.DeepEqual(masked, want) {
		t.Errorf("entities = %v, want %v", masked, want)
	}
}

func BenchmarkMask8KB(b *testing.B) {
	body := strings.Repeat("Hallo, Rückruf an 030 1234567 oder max@firma.de, Bestellung 123456789. ", 120)
	for i := 0; i < b.N; i++ {
		Mask(body)
	}
}

func TestEmptyResultsEncodeAsJSONArray(t *testing.T) {
	_, masked := Mask("nothing to hide")
	for _, v := range []any{masked, NewMasker().Entities()} {
		if b, _ := json.Marshal(v); string(b) != "[]" {
			t.Errorf("JSON = %s, want []", b)
		}
	}
}
