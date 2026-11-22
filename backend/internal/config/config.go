// Package config reads the gateway settings from the environment (names match the root README).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port          string
	MockEngine    bool          // MOCK_ENGINE: answer from the built-in mock instead of the Python engine
	EngineURL     string        // ENGINE_URL: base URL of the private Python engine
	EngineTimeout time.Duration // ENGINE_TIMEOUT: 12 s in contract v1, under the console's 20 s request timeout
	WebDir        string        // WEB_DIR: built console (npm run build); /web in infra/Dockerfile.gateway; empty disables it
	InsightsDir   string        // INSIGHTS_DIR: Data analyst's exported JSON files
	RatePerMinute int           // RATE_LIMIT_PER_MIN: triage requests per client per minute; 0 disables
	RateBurst     int           // RATE_LIMIT_BURST: requests a client may send at once
	TrustProxy    bool          // TRUST_PROXY: take the client IP from X-Forwarded-For (only behind our own proxy)
}

func Load() (Config, error) {
	c := Config{
		Port:          env("PORT", "8080"),
		EngineURL:     strings.TrimRight(env("ENGINE_URL", "http://localhost:8000"), "/"),
		WebDir:        env("WEB_DIR", "../frontend/dist"),
		InsightsDir:   env("INSIGHTS_DIR", "../analytics/insights"),
		EngineTimeout: 12 * time.Second,
	}
	var err error
	if c.MockEngine, err = boolEnv("MOCK_ENGINE", true); err != nil {
		return c, err
	}
	if c.TrustProxy, err = boolEnv("TRUST_PROXY", false); err != nil {
		return c, err
	}
	if c.RatePerMinute, err = intEnv("RATE_LIMIT_PER_MIN", 60); err != nil {
		return c, err
	}
	if c.RateBurst, err = intEnv("RATE_LIMIT_BURST", 10); err != nil {
		return c, err
	}
	if v := os.Getenv("ENGINE_TIMEOUT"); v != "" {
		if c.EngineTimeout, err = time.ParseDuration(v); err != nil {
			return c, fmt.Errorf("ENGINE_TIMEOUT: %w", err)
		}
	}
	return c, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func boolEnv(key string, def bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def, fmt.Errorf("%s: want true or false, got %q", key, v)
	}
	return b, nil
}

func intEnv(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def, fmt.Errorf("%s: want a non-negative integer, got %q", key, v)
	}
	return n, nil
}
