// Package daemonctl is the tray's view of the running daemon: a heartbeat
// that keeps the channel watchdog fed while the tray lives, and a liveness
// probe that lets the tray exit once the daemon was stopped elsewhere.
package daemonctl

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// PortFromURL extracts the port of a receipt localUrl such as http://127.0.0.1:7306/ui/.
func PortFromURL(raw string) (int, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() != "127.0.0.1" {
		return 0, false
	}
	p, err := strconv.Atoi(u.Port())
	return p, err == nil && p > 0 && p < 65536
}

// Client talks to the control API on 127.0.0.1:Port.
type Client struct {
	Port int
	HTTP *http.Client
}

func (c Client) do(ctx context.Context, method, route string) (int, error) {
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 3 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+strconv.Itoa(c.Port)+"/api"+route, strings.NewReader("{}"))
	if err != nil {
		return 0, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-blackhole-client", "tray")
	res, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	return res.StatusCode, nil
}

// Beat sends one heartbeat and reports whether the daemon answered.
func (c Client) Beat(ctx context.Context) bool {
	code, err := c.do(ctx, http.MethodPost, "/heartbeat")
	return err == nil && code == http.StatusOK
}

// Watch beats every interval until ctx ends; onGone runs once after
// `misses` consecutive failures (the daemon was stopped or crashed).
func (c Client) Watch(ctx context.Context, interval time.Duration, misses int, onGone func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	failed := 0
	for {
		if ctx.Err() != nil {
			return
		}
		alive := c.Beat(ctx)
		// Local teardown cancels in-flight HTTP too. That is not evidence that
		// the shared daemon disappeared, and must not trigger onGone.
		if ctx.Err() != nil {
			return
		}
		if alive {
			failed = 0
		} else if failed++; failed >= misses {
			onGone()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
