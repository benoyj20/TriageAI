package ratelimit

import (
	"testing"
	"time"
)

func TestBucketRefillsOverTime(t *testing.T) {
	l := New(60, 2) // one token per second, two at once
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }

	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("request %d should pass", i)
		}
	}
	ok, wait := l.Allow("a")
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("third request: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("other clients have their own bucket")
	}
	now = now.Add(time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("a token should have refilled after a second")
	}
}

func TestDisabledAndSweep(t *testing.T) {
	var off *Limiter = New(0, 5)
	if ok, _ := off.Allow("x"); !ok {
		t.Fatal("a disabled limiter allows everything")
	}

	l := New(60, 1)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }
	l.Allow("old")
	now = now.Add(2 * time.Minute)
	l.Allow("new")
	if _, ok := l.buckets["old"]; ok {
		t.Error("idle, fully refilled buckets should be swept")
	}
}
