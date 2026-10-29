package updatefeed

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCheckerDailyCacheManualOverrideAndNoDownload(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	calls := 0
	file := filepath.Join(t.TempDir(), "check-state.json")
	fetch := func(context.Context, string) (*SignedRelease, error) {
		calls++
		return &SignedRelease{Manifest: Manifest{Version: "0.3.202"}}, nil
	}
	c := newChecker("0.3.201", file, fetch, func() time.Time { return now })
	if s, ran := c.Check(context.Background(), false); !ran || s.State != "available" {
		t.Fatal(s, ran)
	}
	c = newChecker("0.3.201", file, fetch, func() time.Time { return now })
	if _, ran := c.Check(context.Background(), false); ran {
		t.Fatal("checked again within interval")
	}
	if _, ran := c.Check(context.Background(), true); !ran {
		t.Fatal("manual check suppressed")
	}
	now = now.Add(24 * time.Hour)
	if _, ran := c.Check(context.Background(), false); !ran || calls != 3 {
		t.Fatal("daily refresh missing", calls)
	}
	raw, _ := os.ReadFile(file)
	if strings.Contains(string(raw), "https:") {
		t.Fatal("metadata URL leaked into status")
	}
}
func TestCheckerFailureDoesNotClaimLatestAndRetriesAfterHour(t *testing.T) {
	now := time.Now()
	calls := 0
	c := newChecker("0.3.201", filepath.Join(t.TempDir(), "state.json"), func(context.Context, string) (*SignedRelease, error) {
		calls++
		return nil, errors.New("network failure with private URL")
	}, func() time.Time { return now })
	s, _ := c.Check(context.Background(), false)
	if s.State != "error" || s.ErrorCode != "update_check_failed" {
		t.Fatal(s)
	}
	now = now.Add(20 * time.Minute)
	if _, ran := c.Check(context.Background(), false); ran {
		t.Fatal("failure loop")
	}
	now = now.Add(time.Hour)
	c.Check(context.Background(), false)
	if calls != 2 {
		t.Fatal(calls)
	}
}
func TestCheckerCoalescesConcurrentCalls(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	c := newChecker("0.3.201", "", func(context.Context, string) (*SignedRelease, error) {
		calls.Add(1)
		close(entered)
		<-release
		return nil, nil
	}, time.Now)
	done := make(chan struct{})
	go func() { c.Check(context.Background(), true); close(done) }()
	<-entered
	if s, ran := c.Check(context.Background(), true); ran || s.State != "checking" {
		t.Fatal(s, ran)
	}
	close(release)
	<-done
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
}
func TestCheckerRejectsBadCacheAndChangedVersion(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	os.WriteFile(file, []byte(`{"schemaVersion":1,"currentVersion":"0.3.201","state":"available","availableVersion":"../../evil"}`), 0600)
	if s := ReadCheckStatus(file, "0.3.201"); s.State != "idle" {
		t.Fatal(s)
	}
	c := newChecker("0.3.201", file, func(context.Context, string) (*SignedRelease, error) { return nil, nil }, time.Now)
	c.Check(context.Background(), true)
	if s := ReadCheckStatus(file, "0.3.202"); s.State != "idle" {
		t.Fatal(s)
	}
}
func TestCheckerCancelledStartupNeverCallsNetwork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := newChecker("0.3.201", "", func(context.Context, string) (*SignedRelease, error) {
		t.Fatal("network after cancellation")
		return nil, nil
	}, time.Now)
	c.Run(ctx, nil)
}
