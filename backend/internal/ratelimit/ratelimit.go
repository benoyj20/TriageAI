// Package ratelimit is a per-client token bucket for the triage endpoint (FS-17).
package ratelimit

import (
	"math"
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	seen   time.Time
}

// Limiter allows Burst requests at once per key, refilled at PerMinute per minute.
type Limiter struct {
	perSecond float64
	burst     float64
	now       func() time.Time
	mu        sync.Mutex
	buckets   map[string]*bucket
	swept     time.Time
}

// New returns nil when perMinute is 0; a nil Limiter allows everything.
func New(perMinute, burst int) *Limiter {
	if perMinute <= 0 {
		return nil
	}
	return &Limiter{perSecond: float64(perMinute) / 60, burst: float64(max(burst, 1)), now: time.Now, buckets: map[string]*bucket{}}
}

// Allow takes one token for key. When none is left it returns how long until the next one.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	if l == nil {
		return true, 0
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, seen: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.seen).Seconds()*l.perSecond)
	b.seen = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / l.perSecond * float64(time.Second))
	return false, wait
}

// sweep drops buckets that have refilled completely, so memory stays bounded by active clients.
func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.swept) < time.Minute {
		return
	}
	l.swept = now
	full := time.Duration(l.burst / l.perSecond * float64(time.Second))
	for k, b := range l.buckets {
		if now.Sub(b.seen) > full {
			delete(l.buckets, k)
		}
	}
}
