package distribution

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (string, Manifest) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	for _, key := range []string{"BLACKHOLE_HOME", "BLACKHOLE_DB", "BLACKHOLE_SHARED_BIN", "BH_CORE_STORE"} {
		t.Setenv(key, "")
	}
	m := Manifest{Environment: "test", Version: "1.0.0", Files: map[string]string{}}
	for _, name := range []string{"bootstrap/node.exe", "bootstrap/core-manager-cli.mjs", "bootstrap/trust.json", "seed/core.zip"} {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("fixture:"+name), 0600); err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256([]byte("fixture:" + name))
		m.Files[name] = hex.EncodeToString(h[:])
	}
	setTrust(t, root, &m, "test", "test-fixture")
	return root, m
}
func setTrust(t *testing.T, root string, m *Manifest, environment, key string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"environment": environment, "publicKeys": map[string]string{key: "fixture-public-key"}})
	if err := os.WriteFile(filepath.Join(root, "bootstrap/trust.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	m.Files["bootstrap/trust.json"] = hex.EncodeToString(sum[:])
}
func TestProductionRejectsPinnedTestTrust(t *testing.T) {
	root, m := fixture(t)
	m.Environment = "production"
	if _, err := Load(root, encoded(m)); err == nil {
		t.Fatal("accepted environment mismatch")
	}
	setTrust(t, root, &m, "production", "TEST-fixture")
	if _, err := Load(root, encoded(m)); err == nil {
		t.Fatal("accepted test root")
	}
}
func encoded(m Manifest) string { b, _ := json.Marshal(m); return base64.StdEncoding.EncodeToString(b) }
func TestDistributionPinsAndIsolation(t *testing.T) {
	root, m := fixture(t)
	t.Setenv("BH_CORE_STORE", "")
	t.Setenv("BLACKHOLE_HOME", "")
	t.Setenv("BLACKHOLE_DB", "")
	bundle, err := Load(root, encoded(m))
	if err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	if bundle.Client.Store != filepath.Join(home, ".blackhole", "core") || !filepath.IsAbs(bundle.Client.Node) {
		t.Fatal("canonical user-profile store missing")
	}
	values := map[string]string{}
	for _, entry := range bundle.Client.Env {
		k, v, _ := strings.Cut(entry, "=")
		values[k] = v
	}
	if values["BLACKHOLE_HOME"] != "" || values["BLACKHOLE_DB"] != "" || (values["BLACKHOLE_TUNNEL"] != "off" && values["BLACKHOLE_TUNNEL"] != "manual") {
		t.Fatal("launcher must defer default data paths to the pinned Manager")
	}
	if bundle.SeedHash != m.Files["seed/core.zip"] {
		t.Fatal("seed pin missing")
	}
}
func TestDistributionHasNoManifestFallback(t *testing.T) {
	root, _ := fixture(t)
	for _, value := range []string{"", "garbage", base64.StdEncoding.EncodeToString([]byte(`{"environment":"test"}`))} {
		if _, err := Load(root, value); err == nil {
			t.Fatal("accepted untrusted manifest")
		}
	}
}
func TestDistributionTamperAndMissingBootstrapFailClosed(t *testing.T) {
	for _, name := range []string{"bootstrap/node.exe", "bootstrap/core-manager-cli.mjs", "bootstrap/trust.json"} {
		t.Run(name, func(t *testing.T) {
			root, m := fixture(t)
			if err := os.WriteFile(filepath.Join(root, name), []byte("modified"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(root, encoded(m)); err == nil {
				t.Fatal("tamper accepted")
			}
			if err := os.Remove(filepath.Join(root, name)); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(root, encoded(m)); err == nil {
				t.Fatal("missing bootstrap accepted")
			}
		})
	}
}
func TestSeedIsDeferredForVerifiedCoreReuse(t *testing.T) {
	root, m := fixture(t)
	if err := os.Remove(filepath.Join(root, "seed/core.zip")); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, encoded(m)); err != nil {
		t.Fatal(err)
	}
	m.Files["seed/core.zip"] = "invalid"
	if _, err := Load(root, encoded(m)); err == nil {
		t.Fatal("missing seed trust pin accepted")
	}
}
func TestEveryChannelRejectsNoncanonicalStoreOverride(t *testing.T) {
	for _, environment := range []string{"test", "production"} {
		t.Run(environment, func(t *testing.T) {
			root, m := fixture(t)
			m.Environment = environment
			setTrust(t, root, &m, environment, "release-fixture")
			t.Setenv("BH_CORE_STORE", filepath.Join(t.TempDir(), "other-store"))
			if _, err := Load(root, encoded(m)); err == nil || !strings.Contains(err.Error(), "noncanonical_storage_path") {
				t.Fatal("alternate Manager store accepted", err)
			}
		})
	}
}

func TestAllInstalledChannelsUseTheSameProfile(t *testing.T) {
	root, m := fixture(t)
	first, err := Load(root, encoded(m))
	if err != nil {
		t.Fatal(err)
	}
	m.Environment = "production"
	setTrust(t, root, &m, "production", "release-fixture")
	second, err := Load(root, encoded(m))
	if err != nil {
		t.Fatal(err)
	}
	if first.Client.Store != second.Client.Store {
		t.Fatal("release channel forked the data store")
	}
}

func TestV2ManifestRunsManagerFromVerifiedStableRuntime(t *testing.T) {
    root, manifest := fixture(t)
    home, err := os.UserHomeDir()
    if err != nil { t.Fatal(err) }
    home, err = filepath.EvalSymlinks(home)
    if err != nil { t.Fatal(err) }
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    manifest.NodeRuntime = "shared-cache"
    license := []byte("TEST NODE LICENSE")
    licenseFile := filepath.Join(root,"bootstrap","node-LICENSE")
    if err := os.WriteFile(licenseFile, license, 0600); err != nil { t.Fatal(err) }
    hash := sha256.Sum256(license)
    manifest.Files["bootstrap/node-LICENSE"] = hex.EncodeToString(hash[:])
    bundle, err := Load(root, encoded(manifest))
    if err != nil { t.Fatal(err) }
    if !strings.HasPrefix(bundle.Client.Node,filepath.Join(home,".blackhole","core","runtimes")+string(os.PathSeparator)) { t.Fatal(bundle.Client.Node) }
    if strings.HasPrefix(bundle.Client.Node,root+string(os.PathSeparator)) { t.Fatal("Core runtime still belongs to replaceable installation") }
    if bundle.Client.Entry != filepath.Join(root,"bootstrap","core-manager-cli.mjs") { t.Fatal("unexpected manager entry") }
    if err := os.WriteFile(licenseFile,[]byte("changed"),0600);err!=nil{t.Fatal(err)}
    if _,err := Load(root,encoded(manifest));err==nil{t.Fatal("license pin mismatch accepted")}
}
