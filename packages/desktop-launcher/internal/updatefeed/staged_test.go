package updatefeed

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPostponedDownloadIsReusedOnlyWhileVerified(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	root := t.TempDir()
	stage, err := f.Stage(context.Background(), *rel, root)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.FindStagedRelease(root, *rel); got != stage {
		t.Fatal(got, stage)
	}
	if err = os.WriteFile(filepath.Join(stage, "setup.exe"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := f.FindStagedRelease(root, *rel); got != "" {
		t.Fatal("tampered cached installer reused", got)
	}
}
