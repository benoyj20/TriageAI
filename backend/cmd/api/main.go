// Command gateway is the TriageAI Go gateway (FS-02): it validates tickets, masks PII, calls the
// engine (or the built-in mock) and serves the built console.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Dogtags27/gdg-sentinal/backend/internal/api"
	"github.com/Dogtags27/gdg-sentinal/backend/internal/config"
	"github.com/Dogtags27/gdg-sentinal/backend/internal/engine"
	"github.com/Dogtags27/gdg-sentinal/backend/internal/ratelimit"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		log.Error("bad configuration", "err", err)
		os.Exit(2)
	}

	var eng engine.Engine = engine.NewClient(cfg.EngineURL, cfg.EngineTimeout)
	engineURL := cfg.EngineURL
	if cfg.MockEngine {
		eng = engine.NewMock()
		engineURL = "" // no ticket store without the live engine
	}
	srv := &api.Server{
		Engine:      eng,
		Limiter:     ratelimit.New(cfg.RatePerMinute, cfg.RateBurst),
		WebDir:      cfg.WebDir,
		InsightsDir: cfg.InsightsDir,
		TrustProxy:  cfg.TrustProxy,
		Log:         log,
		EngineURL:   engineURL,
	}
	hs := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cfg.EngineTimeout + 10*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Info("gateway listening", "addr", hs.Addr, "mode", eng.Mode(), "engine_url", cfg.EngineURL,
			"web_dir", cfg.WebDir, "rate_limit_per_min", cfg.RatePerMinute)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped", "err", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := hs.Shutdown(shutdown); err != nil {
		log.Error("shutdown", "err", err)
	}
	log.Info("gateway stopped")
}
