package updatefeed

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// CheckStatus is presentation-only. It contains no URLs, signatures, tickets,
// paths or executable decisions. Installing always re-verifies the release.
type CheckStatus struct {
	SchemaVersion    int       `json:"schemaVersion"`
	CurrentVersion   string    `json:"currentVersion"`
	State            string    `json:"state"`
	AvailableVersion string    `json:"availableVersion,omitempty"`
	CheckedAt        time.Time `json:"checkedAt"`
	ErrorCode        string    `json:"errorCode,omitempty"`
}
type checkRelease func(context.Context, string) (*SignedRelease, error)

// Checker is owned by the single native tray, not by the browser or Core.
// Failed/disabled checks never prevent normal application startup or login.
type Checker struct {
	mu            sync.Mutex
	version, file string
	now           func() time.Time
	check         checkRelease
	busy          bool
	current       CheckStatus
	release       *SignedRelease
}

// VerifiedRelease is populated only by this process's successful signed check.
// A status restored from disk never becomes an executable release.
func (c *Checker) VerifiedRelease() *SignedRelease {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.release == nil || c.current.State != "available" {
		return nil
	}
	r := *c.release
	r.Raw = append([]byte(nil), r.Raw...)
	return &r
}
func NewChecker(feed Feed, file string) *Checker {
	return newChecker(feed.Config.CurrentVersion, file, feed.Check, time.Now)
}
func newChecker(version, file string, check checkRelease, now func() time.Time) *Checker {
	c := &Checker{version: version, file: file, check: check, now: now, current: CheckStatus{SchemaVersion: 1, CurrentVersion: version, State: "idle"}}
	if s, ok := readCheckStatus(file, version); ok {
		c.current = s
	}
	return c
}
func validStatus(s CheckStatus, version string) bool {
	if s.SchemaVersion != 1 || s.CurrentVersion != version {
		return false
	}
	switch s.State {
	case "idle", "checking", "current", "available", "error":
	default:
		return false
	}
	if s.State == "available" {
		n, e := compareVersion(s.AvailableVersion, version)
		if e != nil || n <= 0 {
			return false
		}
	}
	return s.ErrorCode == "" || s.ErrorCode == "update_check_failed"
}
func readCheckStatus(file, version string) (CheckStatus, bool) {
	var result CheckStatus
	f, err := os.Open(file)
	if err != nil {
		return result, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return result, false
	}
	raw := make([]byte, info.Size())
	if _, err = f.ReadAt(raw, 0); err != nil {
		return result, false
	}
	if decode(raw, &result) != nil || !validStatus(result, version) {
		return CheckStatus{}, false
	}
	return result, true
}

// ReadCheckStatus allows another native window to render a cached status. A
// changed/tampered cache cannot provide a trusted installer or download URL.
func ReadCheckStatus(file, version string) CheckStatus {
	if s, ok := readCheckStatus(file, version); ok {
		return s
	}
	return CheckStatus{SchemaVersion: 1, CurrentVersion: version, State: "idle"}
}
func (c *Checker) Status() CheckStatus { c.mu.Lock(); defer c.mu.Unlock(); return c.current }
func (c *Checker) Check(ctx context.Context, force bool) (CheckStatus, bool) {
	c.mu.Lock()
	now := c.now()
	if c.busy {
		s := c.current
		c.mu.Unlock()
		return s, false
	}
	interval := 24 * time.Hour
	if c.current.State == "error" {
		interval = time.Hour
	}
	if c.current.State == "checking" {
		interval = 0
	} // Recover an interrupted prior check.
	age := now.Sub(c.current.CheckedAt)
	if !force && !c.current.CheckedAt.IsZero() && age >= 0 && age < interval {
		s := c.current
		c.mu.Unlock()
		return s, false
	}
	c.busy = true
	c.current.State = "checking"
	c.current.ErrorCode = ""
	c.persist()
	c.mu.Unlock()
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	release, err := c.check(bounded, c.version)
	cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.busy = false
	c.release = nil
	c.current = CheckStatus{SchemaVersion: 1, CurrentVersion: c.version, State: "current", CheckedAt: now}
	if err != nil {
		c.current.State = "error"
		c.current.ErrorCode = "update_check_failed"
	} else if release != nil {
		// Check validates signed metadata; repeat version comparison at this seam
		// so an incorrect adapter cannot publish a stale status.
		newer, e := compareVersion(release.Manifest.Version, c.version)
		if e != nil || newer <= 0 {
			c.current.State = "error"
			c.current.ErrorCode = "update_check_failed"
		} else {
			c.current.State = "available"
			c.current.AvailableVersion = release.Manifest.Version
			c.release = release
		}
	}
	c.persist()
	return c.current, true
}
func (c *Checker) persist() {
	// An unwritable preference/cache directory must not crash the application.
	if c.file == "" || os.MkdirAll(filepath.Dir(c.file), 0700) != nil {
		return
	}
	raw, err := json.Marshal(c.current)
	if err != nil {
		return
	}
	f, err := os.CreateTemp(filepath.Dir(c.file), "check-*.partial")
	if err != nil {
		return
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return
	}
	if err = f.Close(); err != nil {
		return
	}
	_ = os.Rename(name, c.file)
}

// Run checks after startup, then periodically wakes to evaluate the durable
// daily schedule. It neither downloads an installer nor shows modal dialogs.
func (c *Checker) Run(ctx context.Context, onStatus func(CheckStatus)) {
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if s, ran := c.Check(ctx, false); ran && onStatus != nil {
			onStatus(s)
		}
		timer.Reset(30 * time.Minute)
	}
}
