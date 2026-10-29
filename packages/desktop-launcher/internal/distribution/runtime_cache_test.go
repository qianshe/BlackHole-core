package distribution

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestRuntimeDirectoryExistingVolumeRootIsNotRecreated(t *testing.T) {
	root := filepath.VolumeName(t.TempDir()) + string(os.PathSeparator)
	if err := safeRuntimeDirectory(root); err != nil {
		t.Fatalf("existing volume root must be accepted after Lstat, not re-Mkdir: %v", err)
	}
}
func TestRuntimeDirectoryRejectsFileInsteadOfSilentlyTreatingItAsDirectory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := safeRuntimeDirectory(file); err == nil || !strings.Contains(err.Error(), "runtime_cache_link_rejected") {
		t.Fatalf("unexpected result for existing file: %v", err)
	}
}

func runtimeFixture(t *testing.T) (string, string, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(base, "home", ".blackhole", "core")
	if err := os.MkdirAll(filepath.Join(root, "bootstrap"), 0700); err != nil {
		t.Fatal(err)
	}
	bytes := []byte("NON-EXECUTABLE NODE FIXTURE")
	license := []byte("TEST LICENSE")
	for name, content := range map[string][]byte{"node.exe": bytes, "node-LICENSE": license} {
		if err := os.WriteFile(filepath.Join(root, "bootstrap", name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := sha256.Sum256(bytes)
	l := sha256.Sum256(license)
	return root, store, hex.EncodeToString(h[:]), hex.EncodeToString(l[:])
}
func TestRuntimeCacheSurvivesShellRemovalAndReusesExactNode(t *testing.T) {
	root, store, h, l := runtimeFixture(t)
	exe, err := prepareRuntimeCache(root, store, h, l)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(exe, store+string(os.PathSeparator)) {
		t.Fatal(exe)
	}
	again, err := prepareRuntimeCache(root, store, h, l)
	if err != nil || exe != again {
		t.Fatal(err, again)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	// A Desktop shell uninstall cannot delete the running v2 daemon's Node.
	if err := verifyRuntimeCache(filepath.Dir(exe), h, l); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(store), "blackhole.db")); !os.IsNotExist(err) {
		t.Fatal("runtime preparation touched database")
	}
}
func TestRuntimeCacheRefusesTamperAndUnapprovedDLL(t *testing.T) {
	for _, member := range []string{"node.exe", "injected.dll"} {
		t.Run(member, func(t *testing.T) {
			root, store, h, l := runtimeFixture(t)
			exe, err := prepareRuntimeCache(root, store, h, l)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(filepath.Dir(exe), member), []byte("tampered"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := prepareRuntimeCache(root, store, h, l); err == nil {
				t.Fatal("corrupt runtime was reused or silently repaired")
			}
		})
	}
}
func TestConcurrentRuntimePublicationIsIdempotent(t *testing.T) {
	root, store, h, l := runtimeFixture(t)
	var wg sync.WaitGroup
	outcomes := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := prepareRuntimeCache(root, store, h, l); outcomes <- err }()
	}
	wg.Wait()
	close(outcomes)
	for err := range outcomes {
		if err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(store, "runtimes"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("leftover runtimes or staging directories: %d", len(entries))
	}
}
func TestRuntimeCacheVerifiesSourceAgainAfterCopy(t *testing.T) {
	root, store, h, l := runtimeFixture(t)
	if err := os.WriteFile(filepath.Join(root, "bootstrap/node.exe"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareRuntimeCache(root, store, h, l); err == nil {
		t.Fatal("mismatched source runtime accepted")
	}
}
