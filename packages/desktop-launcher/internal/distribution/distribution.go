// Package distribution verifies the compiler-pinned, short-lived bootstrap.
// It deliberately does not implement Core selection or archive transactions.
package distribution

import (
	"blackhole/desktop-launcher/internal/coremanager"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Set only by the audited packaging script through the Go linker. There is
// no environment/file override of this trust anchor and no unpinned fallback.
var EncodedManifest string

type Manifest struct {
	Environment string            `json:"environment"`
	Version     string            `json:"version"`
	Files       map[string]string `json:"files"`
	NodeRuntime string            `json:"nodeRuntime,omitempty"`
}
type Bundle struct {
	Client                               coremanager.Client
	Seed, SeedHash, Environment, Version string
}

func fileHash(root, name string) (string, error) {
	current := root
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, `\:`) {
			return "", errors.New("distribution_path_invalid")
		}
		current = filepath.Join(current, part)
		st, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("distribution_link_rejected")
		}
	}
	f, err := os.Open(current)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return "", errors.New("distribution_file_invalid")
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func Load(root, encoded string) (Bundle, error) {
	if encoded == "" || len(encoded) > 65536 {
		return Bundle{}, errors.New("desktop_distribution_missing")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return Bundle{}, errors.New("distribution_manifest_invalid")
	}
	var m Manifest
	if json.Unmarshal(raw, &m) != nil || m.Version == "" || (m.Environment != "test" && m.Environment != "production") || (m.NodeRuntime != "" && m.NodeRuntime != "shared-cache") {
		return Bundle{}, errors.New("distribution_manifest_invalid")
	}
	names := []string{"bootstrap/node.exe", "bootstrap/core-manager-cli.mjs", "bootstrap/trust.json", "seed/core.zip"}
	if m.NodeRuntime == "shared-cache" {
		names = append(names, "bootstrap/node-LICENSE")
	}
	if len(m.Files) != len(names) {
		return Bundle{}, errors.New("distribution_manifest_invalid")
	}
	for _, name := range names {
		pin, exists := m.Files[name]
		bytes, err := hex.DecodeString(pin)
		if !exists || err != nil || len(bytes) != 32 || strings.ToLower(pin) != pin {
			return Bundle{}, errors.New("distribution_pin_invalid")
		}
		// Existing compatible Core must still work if the optional Seed needs repair.
		// The Manager checks this pinned hash only when it actually provisions Seed.
		if name == "seed/core.zip" {
			continue
		}
		got, err := fileHash(root, name)
		if err != nil || got != pin {
			return Bundle{}, errors.New("distribution_integrity_failed:" + name)
		}
	}

	rawTrust, err := os.ReadFile(filepath.Join(root, "bootstrap", "trust.json"))
	var trust struct {
		Environment string            `json:"environment"`
		PublicKeys  map[string]string `json:"publicKeys"`
	}
	if err != nil || len(rawTrust) > 1024*1024 || json.Unmarshal(rawTrust, &trust) != nil || trust.Environment != m.Environment || len(trust.PublicKeys) == 0 {
		return Bundle{}, errors.New("distribution_trust_invalid")
	}
	for key, value := range trust.PublicKeys {
		lower := strings.ToLower(key)
		if value == "" || (m.Environment == "production" && (strings.HasPrefix(lower, "test-") || strings.HasPrefix(lower, "test_"))) {
			return Bundle{}, errors.New("distribution_trust_invalid")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return Bundle{}, errors.New("user_home_must_be_absolute")
	}
	dataRoot := filepath.Join(home, ".blackhole")
	store := filepath.Join(dataRoot, "core")
	// Match the shared TypeScript resolver. Old environment defaults may not
	// silently resurrect an AppData/installation-directory database.
	for key, expected := range map[string]string{
		"BLACKHOLE_HOME": dataRoot, "BLACKHOLE_DB": filepath.Join(dataRoot, "blackhole.db"),
		"BH_CORE_STORE": store, "BLACKHOLE_SHARED_BIN": filepath.Join(dataRoot, "bin"),
	} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" && (!filepath.IsAbs(value) || !strings.EqualFold(filepath.Clean(value), filepath.Clean(expected))) {
			return Bundle{}, errors.New("noncanonical_storage_path:" + key)
		}
	}
	env := os.Environ()
	if m.Environment == "test" {
		if strings.TrimSpace(os.Getenv("BLACKHOLE_TUNNEL")) == "off" {
			env = append(env, "BLACKHOLE_TUNNEL=off")
		} else {
			env = append(env, "BLACKHOLE_TUNNEL=manual")
		}
	}
	node := filepath.Join(root, "bootstrap", "node.exe")
	if m.NodeRuntime == "shared-cache" {
		node, err = prepareRuntimeCache(root, store, m.Files["bootstrap/node.exe"], m.Files["bootstrap/node-LICENSE"])
		if err != nil {
			return Bundle{}, err
		}
	}
	c := coremanager.Client{Node: node, Entry: filepath.Join(root, "bootstrap", "core-manager-cli.mjs"), Store: store, TrustConfig: filepath.Join(root, "bootstrap", "trust.json"), Env: env}
	return Bundle{Client: c, Seed: filepath.Join(root, "seed", "core.zip"), SeedHash: m.Files["seed/core.zip"], Environment: m.Environment, Version: m.Version}, nil
}
func Locate() (Bundle, error) {
	exe, err := os.Executable()
	if err != nil {
		return Bundle{}, err
	}
	return Load(payloadRoot(exe, runtime.GOOS), EncodedManifest)
}

// A macOS app keeps non-code payloads in Resources, never inside MacOS where
// codesign treats nested folders as code bundles. Paths remain compiler-pinned.
func payloadRoot(exe, platform string) string {
	root := filepath.Dir(exe)
	contents := filepath.Dir(root)
	if platform == "darwin" && filepath.Base(root) == "MacOS" && filepath.Base(contents) == "Contents" && strings.HasSuffix(filepath.Base(filepath.Dir(contents)), ".app") {
		return filepath.Join(contents, "Resources", "BlackHole")
	}
	return root
}
