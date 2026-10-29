package updatefeed

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }
func replaceBody(f *Feed, body []byte) {
	f.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body)), ContentLength: -1, Request: r}, nil
	})}
}
func TestDownloadProgressHasMonotonicBytesAndVerifiesBeforeReady(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	root := t.TempDir()
	transfer := NewTransfer(root, f.Config.CurrentVersion)
	var seen []DownloadProgress
	stage, err := transfer.Run(context.Background(), *rel, func(ctx context.Context, notify func(DownloadProgress)) (string, error) {
		return f.StageWithProgress(ctx, *rel, root, func(p DownloadProgress) { seen = append(seen, p); notify(p) })
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) < 3 || seen[0].Bytes != 0 || seen[len(seen)-1].State != "verifying" {
		t.Fatal(seen)
	}
	for i, p := range seen {
		if p.Bytes > p.TotalBytes || (i > 0 && p.Bytes < seen[i-1].Bytes) {
			t.Fatal(seen)
		}
	}
	if transfer.Status().State != "ready" {
		t.Fatal(transfer.Status())
	}
	if _, _, err = f.VerifyStage(stage); err != nil {
		t.Fatal(err)
	}
	if ReadDownloadStatus(root, f.Config.CurrentVersion).State != "ready" {
		t.Fatal("window cannot read ready status")
	}
}
func TestCancelAtFirstOrFinalByteNeverLeavesInstaller(t *testing.T) {
	for _, last := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-body", true: "final-byte"}[last], func(t *testing.T) {
			f, rel, _, closeServer := fixture(t)
			defer closeServer()
			root := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stage, err := f.StageWithProgress(ctx, *rel, root, func(p DownloadProgress) {
				if !last || p.Bytes == p.TotalBytes {
					cancel()
				}
			})
			if !errors.Is(err, context.Canceled) || stage != "" {
				t.Fatalf("stage=%q err=%v", stage, err)
			}
			entries, _ := os.ReadDir(root)
			if len(entries) != 0 {
				t.Fatal("cancelled partial/installer retained", entries)
			}
		})
	}
}
func TestCorruptOrTruncatedDownloadPreservesOtherFiles(t *testing.T) {
	for _, kind := range []string{"truncated", "same-size-corruption", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			f, rel, body, closeServer := fixture(t)
			defer closeServer()
			changed := append([]byte(nil), body...)
			switch kind {
			case "truncated":
				changed = changed[:len(changed)-10]
			case "same-size-corruption":
				changed[0] ^= 255
			case "oversized":
				changed = append(changed, 1)
			}
			replaceBody(&f, changed)
			root := t.TempDir()
			marker := filepath.Join(root, "existing-data-marker")
			if err := os.WriteFile(marker, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			stage, err := f.Stage(context.Background(), *rel, root)
			if err == nil || !strings.Contains(err.Error(), "integrity_failed") || stage != "" {
				t.Fatal(stage, err)
			}
			contents, _ := os.ReadFile(marker)
			if string(contents) != "preserve" {
				t.Fatal("unrelated data changed")
			}
			entries, _ := os.ReadDir(root)
			if len(entries) != 1 {
				t.Fatal("failed download not cleaned", entries)
			}
		})
	}
}
func TestWindowCancellationIsBoundToTheActiveAttempt(t *testing.T) {
	root := t.TempDir()
	tr := NewTransfer(root, "0.3.201")
	rel := SignedRelease{Manifest: Manifest{Version: "0.3.202", InstallerBytes: 2 * 1024 * 1024}}
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := tr.Run(context.Background(), rel, func(ctx context.Context, _ func(DownloadProgress)) (string, error) {
			close(started)
			<-ctx.Done()
			return "", ctx.Err()
		})
		done <- err
	}()
	<-started
	if _, err := tr.Run(context.Background(), rel, nil); err == nil || err.Error() != "update_download_busy" {
		t.Fatal(err)
	}
	if !RequestDownloadCancel(root, "0.3.201") {
		t.Fatal("native cancellation not queued")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		tr.Cancel()
		t.Fatal("cancel timed out")
	}
	first := tr.Status().Attempt
	entered := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_, err := tr.Run(context.Background(), rel, func(ctx context.Context, notify func(DownloadProgress)) (string, error) {
			close(entered)
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-release:
				notify(DownloadProgress{State: "verifying", Bytes: rel.Manifest.InstallerBytes, TotalBytes: rel.Manifest.InstallerBytes})
				return "fixture-verified-stage", nil
			}
		})
		done <- err
	}()
	<-entered
	if tr.Status().Attempt == first {
		t.Fatal("attempt ID reused")
	}
	select {
	case err := <-done:
		t.Fatal("stale cancellation killed new download", err)
	case <-time.After(550 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if RequestDownloadCancel(root, "0.3.201") {
		t.Fatal("cancel should not target a finished transfer")
	}
}
func TestInvalidStatusIsDisplayOnlyAndCannotChoosePaths(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "download-state.json")
	for _, raw := range []string{`{"state":"ready","path":"C:/bad.exe"}`, strings.Repeat("x", 5000)} {
		os.WriteFile(file, []byte(raw), 0600)
		if got := ReadDownloadStatus(root, "0.3.201"); got.State != "idle" {
			t.Fatal(got)
		}
		if RequestDownloadCancel(root, "0.3.201") {
			t.Fatal("forged status allowed cancel")
		}
	}
}
func TestUnavailableNetworkDoesNotPublishDownloadReady(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	var calls atomic.Int32
	f.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("synthetic network unavailable")
	})}
	root := t.TempDir()
	tr := NewTransfer(root, f.Config.CurrentVersion)
	stage, err := tr.Run(context.Background(), *rel, func(ctx context.Context, notify func(DownloadProgress)) (string, error) {
		return f.StageWithProgress(ctx, *rel, root, notify)
	})
	if err == nil || stage != "" || calls.Load() != 1 || tr.Status().State != "error" {
		t.Fatal(stage, err, tr.Status())
	}
	entries, _ := filepath.Glob(filepath.Join(root, "release-*"))
	if len(entries) != 0 {
		t.Fatal("network failure left installable stage", entries)
	}
}
