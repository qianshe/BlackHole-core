package distribution

import (
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// A v2 daemon must not hold the replaceable Desktop installation open. The one
// delivered Node is copied to a content-addressed Core runtime cache, verified
// on every use, and retained independently when only the shell is uninstalled.
func safeRuntimeDirectory(dir string) error {
	if !filepath.IsAbs(dir) {
		return errors.New("runtime_cache_path_invalid")
	}
	parent := filepath.Dir(dir)
	if parent != dir {
		if err := safeRuntimeDirectory(parent); err != nil {
			return err
		}
	}
	// Windows may report ACCESS_DENIED rather than EXIST when attempting
	// os.Mkdir("C:\\") on an already mounted volume. Check the existing
	// directory first; still inspect every ancestor with Lstat and reject
	// links/non-directories instead of treating errors as success.
	st, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		if createErr := os.Mkdir(dir, 0700); createErr != nil && !os.IsExist(createErr) {
			return createErr
		}
		st, err = os.Lstat(dir)
	}
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("runtime_cache_link_rejected")
	}
	return nil
}

func verifyRuntimeCache(dir, nodeHash, licenseHash string) error {
	// A losing concurrent Windows rename can briefly hold the published directory
	// without read sharing. Retry only that OS lock error; integrity failures remain fatal.
	for attempt := 0; ; attempt++ {
		err := verifyRuntimeCacheOnce(dir, nodeHash, licenseHash)
		if err == nil || runtime.GOOS != "windows" || attempt >= 25 ||
			(!errors.Is(err, syscall.Errno(32)) && !errors.Is(err, syscall.Errno(33))) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func verifyRuntimeCacheOnce(dir, nodeHash, licenseHash string) error {
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("runtime_cache_link_rejected")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	// Extra DLLs or scripts are not part of the pinned runtime.
	if len(entries) != 2 {
		return errors.New("runtime_cache_content_invalid")
	}
	for file, pin := range map[string]string{"node.exe": nodeHash, "LICENSE": licenseHash} {
		got, err := fileHash(dir, file)
		if err != nil || got != pin {
			return errors.New("runtime_cache_integrity_failed")
		}
	}
	return nil
}

func copyRuntimeFile(from, to string) error {
	input, err := os.Open(from)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func prepareRuntimeCache(root, store, nodeHash, licenseHash string) (string, error) {
	// Both hashes come exclusively from the compiler-pinned manifest.
	for _, hash := range []string{nodeHash, licenseHash} {
		if len(hash) != 64 || hash != strings.ToLower(hash) {
			return "", errors.New("runtime_cache_pin_invalid")
		}
		if _, err := hex.DecodeString(hash); err != nil {
			return "", errors.New("runtime_cache_pin_invalid")
		}
	}
	cache := filepath.Join(store, "runtimes")
	if err := safeRuntimeDirectory(cache); err != nil {
		return "", err
	}
	destination := filepath.Join(cache, "node-"+nodeHash+"-"+licenseHash)
	if _, err := os.Lstat(destination); err == nil {
		if err := verifyRuntimeCache(destination, nodeHash, licenseHash); err != nil {
			return "", err
		}
		return filepath.Join(destination, "node.exe"), nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	stage, err := os.MkdirTemp(cache, ".node-stage-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	if err := copyRuntimeFile(filepath.Join(root, "bootstrap", "node.exe"), filepath.Join(stage, "node.exe")); err != nil {
		return "", err
	}
	if err := copyRuntimeFile(filepath.Join(root, "bootstrap", "node-LICENSE"), filepath.Join(stage, "LICENSE")); err != nil {
		return "", err
	}
	if err := verifyRuntimeCache(stage, nodeHash, licenseHash); err != nil {
		return "", err
	}
	if err := os.Rename(stage, destination); err != nil {
		// Another concurrent starter may have published the same verified pair.
		if verifyRuntimeCache(destination, nodeHash, licenseHash) != nil {
			return "", errors.New("runtime_cache_publish_failed")
		}
	}
	if err := verifyRuntimeCache(destination, nodeHash, licenseHash); err != nil {
		return "", err
	}
	return filepath.Join(destination, "node.exe"), nil
}
