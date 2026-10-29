package updatefeed

import (
	"os"
	"path/filepath"
	"strings"
)

// FindStagedRelease reuses a postponed download only after checking it against
// the freshly verified feed and rehashing the exact installer. Cached status
// cannot choose a release. No downloaded code is executed here.
func (f Feed) FindStagedRelease(root string, want SignedRelease) string {
	if _, err := f.verify(want.Raw, want.Signature); err != nil {
		return ""
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	count := 0
	for _, e := range entries {
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 || !strings.HasPrefix(e.Name(), "release-") {
			continue
		}
		count++
		if count > 128 {
			break
		}
		dir := filepath.Join(root, e.Name())
		file, err := os.Open(filepath.Join(dir, "release.json"))
		if err != nil {
			continue
		}
		info, err := file.Stat()
		if err != nil || info.Size() > maxMetadata {
			file.Close()
			continue
		}
		raw := make([]byte, info.Size())
		_, err = file.ReadAt(raw, 0)
		file.Close()
		if err != nil {
			continue
		}
		var hint Manifest
		if decode(raw, &hint) != nil || hint != want.Manifest {
			continue
		}
		verified, _, err := f.VerifyStage(dir)
		if err == nil && verified == want.Manifest {
			return dir
		}
	}
	return ""
}
