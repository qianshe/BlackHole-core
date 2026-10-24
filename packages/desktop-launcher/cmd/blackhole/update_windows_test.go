//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateStageMustBeDirectChildOfOwnedRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Updates")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(root, "release-1234")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if !stageIsOwned(root, stage) {
		t.Fatal("valid staged release rejected")
	}
	cases := []string{
		root,
		filepath.Dir(root),
		filepath.Join(root, "other-1234"),
		filepath.Join(stage, "nested-release"),
		filepath.Join(root, "release-missing"),
	}
	for _, candidate := range cases {
		if stageIsOwned(root, candidate) {
			t.Fatalf("untrusted update stage accepted: %q", candidate)
		}
	}
	sibling := filepath.Join(filepath.Dir(root), "Updates-elsewhere", "release-123")
	if err := os.MkdirAll(sibling, 0700); err != nil {
		t.Fatal(err)
	}
	if stageIsOwned(root, sibling) {
		t.Fatal("sibling stage accepted")
	}
	// Windows test users may lack symlink creation privileges; when allowed,
	// reject a reparse point even if it resolves to a signed-looking folder.
	link := filepath.Join(root, "release-link")
	if err := os.Symlink(stage, link); err == nil && stageIsOwned(root, link) {
		t.Fatal("linked update stage accepted")
	}
}
