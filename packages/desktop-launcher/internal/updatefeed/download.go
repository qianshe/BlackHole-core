package updatefeed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Progress/status never contain a URL, local path, account or executable args.
type DownloadProgress struct {
	State      string `json:"state"`
	Bytes      int64  `json:"bytes"`
	TotalBytes int64  `json:"totalBytes"`
}
type downloadReader struct {
	ctx          context.Context
	reader       io.Reader
	total, bytes int64
	last         time.Time
	notify       func(DownloadProgress)
}

func (r *downloadReader) report(state string, force bool) {
	if r.notify == nil {
		return
	}
	now := time.Now()
	if !force && now.Sub(r.last) < 200*time.Millisecond && r.bytes < r.total {
		return
	}
	r.last = now
	n := r.bytes
	if n > r.total {
		n = r.total
	}
	r.notify(DownloadProgress{State: state, Bytes: n, TotalBytes: r.total})
}
func (r *downloadReader) Read(buf []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(buf)
	r.bytes += int64(n)
	r.report("downloading", false)
	if ctxErr := r.ctx.Err(); ctxErr != nil {
		return n, ctxErr
	}
	return n, err
}

type DownloadStatus struct {
	SchemaVersion  int    `json:"schemaVersion"`
	CurrentVersion string `json:"currentVersion"`
	Version        string `json:"version"`
	Attempt        string `json:"attempt"`
	DownloadProgress
	UpdatedAt time.Time `json:"updatedAt"`
}

func busyDownload(s DownloadStatus) bool {
	return s.State == "downloading" || s.State == "verifying" || s.State == "cancelling"
}
func validDownload(s DownloadStatus, current string) bool {
	if s.SchemaVersion != 1 || s.CurrentVersion != current || !versionPattern.MatchString(current) || !versionPattern.MatchString(s.Version) || len(s.Attempt) != 32 {
		return false
	}
	if _, err := hex.DecodeString(s.Attempt); err != nil {
		return false
	}
	if s.TotalBytes < 1024*1024 || s.TotalBytes > maxInstaller || s.Bytes < 0 || s.Bytes > s.TotalBytes || s.UpdatedAt.IsZero() {
		return false
	}
	switch s.State {
	case "downloading", "verifying", "cancelling", "ready", "cancelled", "error", "interrupted":
		return true
	default:
		return false
	}
}
func readSmallJSON(file string, out any) error {
	before, err := os.Lstat(file)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() > 4096 {
		return errors.New("update_status_invalid")
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return errors.New("update_status_changed")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return err
	}
	if len(raw) > 4096 {
		return errors.New("update_status_invalid")
	}
	return decode(raw, out)
}
func writeSmallJSON(file string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > 4096 {
		return errors.New("update_status_invalid")
	}
	if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), "download-*.partial")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, file)
}

// Cache is display-only. Neither 'ready' nor a cancel request may install or
// select an executable; the caller must retain/reverify the signed release.
func ReadDownloadStatus(root, current string) DownloadStatus {
	var s DownloadStatus
	if readSmallJSON(filepath.Join(root, "download-state.json"), &s) != nil || !validDownload(s, current) {
		return DownloadStatus{DownloadProgress: DownloadProgress{State: "idle"}}
	}
	age := time.Since(s.UpdatedAt)
	if busyDownload(s) && (age > time.Minute || age < -time.Minute) {
		s.State = "interrupted"
	}
	return s
}

type cancelDownloadRequest struct {
	CurrentVersion string `json:"currentVersion"`
	Attempt        string `json:"attempt"`
}

// The only cross-process request is cancellation of this exact download.
// A webpage cannot submit filesystem paths, URLs, hashes, PIDs or an install.
func RequestDownloadCancel(root, current string) bool {
	s := ReadDownloadStatus(root, current)
	if !busyDownload(s) {
		return false
	}
	return writeSmallJSON(filepath.Join(root, "download-cancel.json"), cancelDownloadRequest{current, s.Attempt}) == nil
}

type Transfer struct {
	mu            sync.Mutex
	root, current string
	busy          bool
	status        DownloadStatus
	cancel        context.CancelFunc
}

func NewTransfer(root, current string) *Transfer {
	return &Transfer{root: root, current: current, status: DownloadStatus{DownloadProgress: DownloadProgress{State: "idle"}}}
}
func (t *Transfer) Status() DownloadStatus { t.mu.Lock(); defer t.mu.Unlock(); return t.status }
func (t *Transfer) Cancel() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.busy || t.cancel == nil {
		return false
	}
	t.status.State = "cancelling"
	t.status.UpdatedAt = time.Now().UTC()
	t.persist()
	t.cancel()
	return true
}
func (t *Transfer) persist() {
	_ = writeSmallJSON(filepath.Join(t.root, "download-state.json"), t.status)
}
func (t *Transfer) Run(ctx context.Context, rel SignedRelease, download func(context.Context, func(DownloadProgress)) (string, error)) (string, error) {
	t.mu.Lock()
	if t.busy {
		t.mu.Unlock()
		return "", errors.New("update_download_busy")
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		t.mu.Unlock()
		return "", err
	}
	sub, cancel := context.WithCancel(ctx)
	t.busy = true
	t.cancel = cancel
	t.status = DownloadStatus{SchemaVersion: 1, CurrentVersion: t.current, Version: rel.Manifest.Version, Attempt: hex.EncodeToString(id), DownloadProgress: DownloadProgress{State: "downloading", TotalBytes: rel.Manifest.InstallerBytes}, UpdatedAt: time.Now().UTC()}
	attempt := t.status.Attempt
	t.persist()
	t.mu.Unlock()
	finish := make(chan struct{})
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-finish:
				return
			case <-sub.Done():
				return
			case <-ticker.C:
				var req cancelDownloadRequest
				if readSmallJSON(filepath.Join(t.root, "download-cancel.json"), &req) == nil && req.Attempt == attempt && req.CurrentVersion == t.current {
					t.Cancel()
					return
				}
				t.mu.Lock()
				if time.Since(t.status.UpdatedAt) > 5*time.Second {
					t.status.UpdatedAt = time.Now().UTC()
					t.persist()
				}
				t.mu.Unlock()
			}
		}
	}()
	stage, err := download(sub, func(p DownloadProgress) {
		t.mu.Lock()
		defer t.mu.Unlock()
		if p.TotalBytes != t.status.TotalBytes || p.Bytes < t.status.Bytes || p.Bytes > p.TotalBytes || (p.State != "downloading" && p.State != "verifying") {
			return
		}
		if t.status.State != "cancelling" {
			t.status.DownloadProgress = p
		}
		t.status.UpdatedAt = time.Now().UTC()
		t.persist()
	})
	close(finish)
	<-joined
	t.mu.Lock()
	// Cancellation may race with the last byte: it must never fall through into
	// a stop/install. A completed signed file can only be reused on a later check.
	if err == nil && sub.Err() != nil {
		err = sub.Err()
	}
	t.status.State = "ready"
	if err != nil {
		stage = ""
		t.status.State = "error"
		if errors.Is(err, context.Canceled) {
			t.status.State = "cancelled"
		}
	}
	t.status.UpdatedAt = time.Now().UTC()
	t.busy = false
	t.cancel = nil
	t.persist()
	t.mu.Unlock()
	cancel()
	return stage, err
}
