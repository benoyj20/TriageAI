// Package pii masks personal data in ticket text before it leaves the gateway (FS-15).
//
// Placeholders follow contracts/README.md: typed and numbered ([EMAIL_1], [PHONE_2], ...), with one
// numbering per ticket so subject and body agree and a repeated value keeps its number:
//
//	m := pii.NewMasker()
//	subject, body := m.Mask(req.Subject), m.Mask(req.Body)
//	masked := m.Entities() // -> response "pii": {"masked": [...]}
//
// The rules mirror frontend/src/api/mockEngine.js; testdata/cases.json is run by both test suites.
package pii

import (
	"regexp"
	"strconv"
	"strings"
)

// Entity reports how many values of one kind were replaced, e.g. {"type":"EMAIL","count":2}.
type Entity struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

type rule struct {
	kind string
	re   *regexp.Regexp
	// group, when set, masks only that capture group (the account number, not its label).
	group int
	// bounded: the match must not touch a word character or '-' on the left, or a word character on
	// the right. RE2 has no lookaround, so this is checked in code.
	bounded bool
	full    *regexp.Regexp // the pattern anchored at both ends, set in init for bounded rules
	// keep reports a match that looks like the pattern but is not PII; prev is the character before it.
	keep func(m string, prev byte) bool
}

// Order matters: each rule runs on the output of the previous ones, so the specific shapes (IBAN, card,
// labelled account numbers, IPs) are replaced before the phone rule can claim their digits.
var rules = []rule{
	{kind: "EMAIL", re: regexp.MustCompile(`[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+`)},
	{
		kind: "IBAN",
		// Compact or 4-spaced, any letter case; the last group can be shorter (German IBANs end in 2 characters).
		re: regexp.MustCompile(`(?i)\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b`),
		// Real IBANs are mostly digits; this keeps "ab12 this that" style text.
		keep: func(m string, _ byte) bool { return len(digitsOf(m)) < 10 },
	},
	{
		kind: "CARD",
		re:   regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`),
		// A card passes Luhn or is grouped like one (4-4-4-4, 4-6-5), so a mistyped card is still masked.
		// After "+" or with a leading 00 it is an international phone number, left to the phone rule.
		keep: func(m string, prev byte) bool {
			if prev == '+' || strings.HasPrefix(m, "00") {
				return true
			}
			return !luhn(digitsOf(m)) && !cardShaped(m)
		},
	},
	{
		kind:  "ACCOUNT",
		re:    regexp.MustCompile(`(?i)\b(account\s*(?:number|no\.?|nr\.?|#)|customer\s*(?:number|no\.?|id|#)|contract\s*(?:number|no\.?)|kontonummer|konto-?nr\.?|kundennummern?|kunden-?nr\.?|kd\.?-?nr\.?|vertragsnummer|vertrags-?nr\.?)((?:\s+(?:is|ist|lautet|lautete|was|war))?\s*[:#]?\s*)([A-Z0-9][A-Z0-9-]{3,23}(?: \d[A-Z0-9-]{0,9}){0,6})\b`),
		group: 3,
		// The value must contain a digit, so "customer number is missing" stays as it is.
		keep: func(m string, _ byte) bool { return !strings.ContainsAny(m, "0123456789") },
	},
	{
		kind: "IP",
		// IPv4, full IPv6, and compressed IPv6 with "::".
		re: regexp.MustCompile(`(?i)\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})\b`),
	},
	{
		kind: "PHONE",
		// +49 (0)30 …, 089 / 1234567, 030 123 45 67, 030-123-45-67: a lead group, one separator, then up to
		// five digit groups.
		re:      regexp.MustCompile(`(?:\+\d{1,3}[ \t-]?(?:\(0\)[ \t]?)?)?\(?0?\d{2,5}\)?(?:[ \t]{0,2}/[ \t]{0,2}|[ \t-])?\d{2,8}(?:[ \t-]\d{2,8}){0,4}`),
		bounded: true,
		// Fewer than 7 digits (years, times) is not a phone number, and neither is a bare digit run such as
		// an order number: it needs +, (, a leading 0, or separators.
		keep: func(m string, _ byte) bool {
			if len(digitsOf(m)) < 7 {
				return true
			}
			return !strings.ContainsAny(m[:1], "+(0") && !strings.ContainsAny(m, " \t-/)")
		},
	},
}

// unicodeSpaces become plain spaces before masking, so "030 1234567" from a mail signature is caught.
var unicodeSpaces = strings.NewReplacer(" ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
	" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
	" ", " ", " ", " ", "　", " ")

// maxBounded caps how far past a start a bounded match can end; phone numbers are far shorter.
const maxBounded = 40

func init() {
	for i := range rules {
		if rules[i].bounded {
			rules[i].full = regexp.MustCompile(`^(?:` + rules[i].re.String() + `)$`)
		}
	}
}

// Masker masks the fields of one ticket with shared numbering. It is not safe for concurrent use.
type Masker struct {
	numbers map[string]map[string]int // type -> value -> placeholder number
	counts  map[string]int            // type -> occurrences masked
}

func NewMasker() *Masker {
	return &Masker{numbers: map[string]map[string]int{}, counts: map[string]int{}}
}

// Mask replaces emails, IBANs, card numbers, labelled account numbers, IP addresses and phone numbers.
// Placeholders can make the text longer than the input.
func (m *Masker) Mask(text string) string {
	text = unicodeSpaces.Replace(text)
	for _, r := range rules {
		text = m.apply(r, text)
	}
	return text
}

// Entities lists the masked types in rule order with their counts; never nil, so JSON encodes [] not null.
func (m *Masker) Entities() []Entity {
	out := []Entity{}
	for _, r := range rules {
		if n := m.counts[r.kind]; n > 0 {
			out = append(out, Entity{Type: r.kind, Count: n})
		}
	}
	return out
}

// Mask masks a single text with its own numbering.
func Mask(text string) (string, []Entity) {
	m := NewMasker()
	out := m.Mask(text)
	return out, m.Entities()
}

func (m *Masker) placeholder(kind, value string) string {
	byValue := m.numbers[kind]
	if byValue == nil {
		byValue = map[string]int{}
		m.numbers[kind] = byValue
	}
	key := strings.ToLower(value)
	n, ok := byValue[key]
	if !ok {
		n = len(byValue) + 1
		byValue[key] = n
	}
	m.counts[kind]++
	return "[" + kind + "_" + strconv.Itoa(n) + "]"
}

func (m *Masker) apply(r rule, text string) string {
	var b strings.Builder
	last, pos := 0, 0
	for pos <= len(text) {
		loc := find(r, text, pos)
		if loc == nil {
			break
		}
		start, end := loc[0], loc[1]
		if r.group > 0 {
			start, end = loc[2*r.group], loc[2*r.group+1]
		}
		value := text[start:end]
		var prev byte
		if start > 0 {
			prev = text[start-1]
		}
		if r.keep != nil && r.keep(value, prev) {
			pos = loc[1]
			continue
		}
		b.WriteString(text[last:start])
		b.WriteString(m.placeholder(r.kind, value))
		last, pos = end, loc[1]
	}
	if last == 0 {
		return text
	}
	b.WriteString(text[last:])
	return b.String()
}

// find returns the leftmost match at or after pos as submatch indexes (whole match first). For bounded
// rules it tries each later start and, for a given start, the longest match that ends on a boundary,
// which is what a backtracking engine with (?<![\w-]) ... (?!\w) would pick.
func find(r rule, text string, pos int) []int {
	if !r.bounded {
		loc := r.re.FindStringSubmatchIndex(text[pos:])
		for i := range loc {
			if loc[i] >= 0 {
				loc[i] += pos
			}
		}
		return loc
	}
	for {
		loc := r.re.FindStringIndex(text[pos:])
		if loc == nil {
			return nil
		}
		start := pos + loc[0]
		if start == 0 || !isWord(text[start-1]) && text[start-1] != '-' {
			if end := longestBounded(r.full, text, start); end > start {
				return []int{start, end}
			}
		}
		pos = start + 1
		if pos > len(text) {
			return nil
		}
	}
}

// longestBounded returns the end of the longest full match of re starting at start that is followed by
// a non-word character or the end of the text, or start if there is none.
func longestBounded(re *regexp.Regexp, text string, start int) int {
	for end := min(len(text), start+maxBounded); end > start; end-- {
		if end < len(text) && isWord(text[end]) {
			continue
		}
		if re.MatchString(text[start:end]) {
			return end
		}
	}
	return start
}

func isWord(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func digitsOf(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// cardShaped reports card-style grouping: 4-4-4-4 (optionally a short fifth group) or Amex 4-6-5.
func cardShaped(m string) bool {
	groups := strings.FieldsFunc(m, func(c rune) bool { return c == ' ' || c == '-' })
	lens := make([]int, len(groups))
	for i, g := range groups {
		lens[i] = len(g)
	}
	switch {
	case len(lens) == 3:
		return lens[0] == 4 && lens[1] == 6 && (lens[2] == 5 || lens[2] == 4)
	case len(lens) == 4 || len(lens) == 5:
		return lens[0] == 4 && lens[1] == 4 && lens[2] == 4 && lens[3] == 4 && (len(lens) == 4 || lens[4] <= 3)
	}
	return false
}

func luhn(digits string) bool {
	sum := 0
	for i := 0; i < len(digits); i++ {
		d := int(digits[len(digits)-1-i] - '0')
		if i%2 == 1 {
			if d *= 2; d > 9 {
				d -= 9
			}
		}
		sum += d
	}
	return len(digits) > 0 && sum%10 == 0
}
