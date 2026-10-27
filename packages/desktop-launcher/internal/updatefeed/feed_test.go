package updatefeed

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (Feed, *SignedRelease, []byte, func()) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte(strings.Repeat("BlackHole signed installer test fixture", 48000))
	sum := sha256.Sum256(binary)
	var feedPayload []byte
	var sig []byte
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest.json":
			w.Write(feedPayload)
		case "/latest.json.sig":
			w.Write(sig)
		case "/setup.exe":
			w.Write(binary)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	m := Manifest{SchemaVersion: 1, Environment: "test", Platform: runtimePlatform(), Arch: runtimeArch(), Version: "0.3.202", BuildID: "r1", CoreVersion: "0.3.202", CoreBuildID: "core-r1", InstallerURL: server.URL + "/setup.exe", InstallerSHA256: hex.EncodeToString(sum[:]), InstallerBytes: int64(len(binary))}
	feedPayload, err = json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	sig = []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, feedPayload)))
	f := Feed{Config: Config{Environment: "test", CurrentVersion: "0.3.201", FeedURL: server.URL + "/latest.json", PublicKey: base64.StdEncoding.EncodeToString(pub)}, Client: server.Client()}
	return f, &SignedRelease{Manifest: m, Raw: feedPayload, Signature: string(sig)}, binary, server.Close
}
func TestSignedFeedCheckStageVerify(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	got, err := f.Check(context.Background(), "0.3.201")
	if err != nil || got == nil || got.Manifest.BuildID != rel.Manifest.BuildID {
		t.Fatal(err, got)
	}
	stage, err := f.Stage(context.Background(), *got, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manifest, file, err := f.VerifyStage(stage)
	if err != nil || manifest.Version != "0.3.202" || filepath.Base(file) != "setup.exe" {
		t.Fatal(err, manifest)
	}
	if older, err := f.Check(context.Background(), "0.3.202"); err != nil || older != nil {
		t.Fatal(err, older)
	}
}
func TestInvalidSignatureNeverStages(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	rel.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64))
	_, err := f.Stage(context.Background(), *rel, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "update_signature_invalid") {
		t.Fatal(err)
	}
}
func TestMutatedInstallerFailsImmediatelyBeforeExecution(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	stage, err := f.Stage(context.Background(), *rel, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(stage, "setup.exe")
	if err := os.WriteFile(file, []byte("malicious replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.VerifyStage(stage); err == nil || !strings.Contains(err.Error(), "integrity_failed") {
		t.Fatal(err)
	}
}
func TestUpdateEnvironmentAndTransportArePinned(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	f.Config.Environment = "production"
	if _, err := f.Check(context.Background(), "0.3.201"); err == nil {
		t.Fatal("must not accept Test release on production")
	}
	f.Config.FeedURL = "http://updates.example.invalid/latest.json"
	if _, err := f.Check(context.Background(), "0.3.201"); err == nil || !strings.Contains(err.Error(), "update_feed_url_invalid") {
		t.Fatal(err)
	}
	f.Config.FeedURL = "https://updates.example.invalid/latest.json"
	rel.Manifest.InstallerURL = "http://updates.example.invalid/setup.exe"
	raw, _ := json.Marshal(rel.Manifest)
	// Even if metadata were legitimately signed, non-TLS installer URLs are
	// categorically refused before HTTP traffic is initiated.
	if validateManifest(rel.Manifest, "test") == nil {
		t.Fatal("http installer accepted")
	}
	_ = raw
}
func TestSignedInstallerNotNewerIsRejectedOnHandoff(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	stage, err := f.Stage(context.Background(), *rel, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f.Config.CurrentVersion = "0.3.202"
	if _, _, err = f.VerifyStage(stage); err == nil || !strings.Contains(err.Error(), "update_version_not_newer") {
		t.Fatal("signed same-version replay accepted:", err)
	}
}

func TestVersionComparisonRejectsDowngradeOrUnknown(t *testing.T) {
	for _, row := range []struct {
		a, b string
		want int
		bad  bool
	}{
		{"0.3.202", "0.3.201", 1, false},
		{"0.3.201", "0.3.201", 0, false},
		{"0.3.200", "0.3.201", -1, false},
		{"0.3.202-rc1", "0.3.201", 0, true},
		{"2147483648.3.1", "0.3.0", 1, false},
	} {
		got, err := compareVersion(row.a, row.b)
		if row.bad != (err != nil) || (!row.bad && got != row.want) {
			t.Fatal(row, got, err)
		}
	}
}
