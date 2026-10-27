// Package updatefeed implements a pinned, signed Windows release feed.
// It downloads artifacts but never launches an installer or controls Core.
package updatefeed

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	maxMetadata  = 64 * 1024
	maxSignature = 1024
	maxInstaller = int64(1024 * 1024 * 1024)
)

// EncodedConfig is pinned at build time by package-desktop.mjs. Development
// builds without a release-owner-controlled feed/signing key cannot update.
var EncodedConfig string

type Config struct {
	Environment    string `json:"environment"`
	CurrentVersion string `json:"currentVersion"`
	FeedURL        string `json:"feedUrl"`
	PublicKey      string `json:"publicKey"`
}
type Manifest struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Environment     string `json:"environment"`
	Platform        string `json:"platform"`
	Arch            string `json:"arch"`
	Version         string `json:"version"`
	BuildID         string `json:"buildId"`
	CoreVersion     string `json:"coreVersion"`
	CoreBuildID     string `json:"coreBuildId"`
	InstallerURL    string `json:"installerUrl"`
	InstallerSHA256 string `json:"installerSha256"`
	InstallerBytes  int64  `json:"installerBytes"`
}
type SignedRelease struct {
	Manifest  Manifest
	Raw       []byte
	Signature string
}
type Feed struct {
	Config Config
	Client *http.Client
}

var segmentPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$`)
var checksumPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

func FromBuild() (Feed, error) {
	if EncodedConfig == "" {
		return Feed{}, errors.New("update_feed_unconfigured")
	}
	raw, err := base64.StdEncoding.DecodeString(EncodedConfig)
	if err != nil {
		return Feed{}, errors.New("update_feed_invalid")
	}
	var c Config
	if err = decode(raw, &c); err != nil {
		return Feed{}, errors.New("update_feed_invalid")
	}
	f := Feed{Config: c}
	if err = f.Validate(); err != nil {
		return Feed{}, err
	}
	return f, nil
}
func safeHTTPS(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.User == nil && parsed.Fragment == "" && parsed.RawQuery == "" && parsed.Opaque == ""
}
func (f Feed) Validate() error {
	if f.Config.Environment != "test" && f.Config.Environment != "production" {
		return errors.New("update_environment_invalid")
	}
	if !versionPattern.MatchString(f.Config.CurrentVersion) {
		return errors.New("update_current_version_invalid")
	}
	if !safeHTTPS(f.Config.FeedURL) {
		return errors.New("update_feed_url_invalid")
	}
	key, err := base64.StdEncoding.DecodeString(f.Config.PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return errors.New("update_public_key_invalid")
	}
	return nil
}
func decode(raw []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	var next any
	if d.Decode(&next) != io.EOF {
		return errors.New("json_trailing_content")
	}
	return nil
}
func compareVersion(a, b string) (int, error) {
	if !versionPattern.MatchString(a) || !versionPattern.MatchString(b) {
		return 0, errors.New("update_version_invalid")
	}
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		l, e1 := strconv.ParseUint(as[i], 10, 32)
		r, e2 := strconv.ParseUint(bs[i], 10, 32)
		if e1 != nil || e2 != nil {
			return 0, errors.New("update_version_invalid")
		}
		if l > r {
			return 1, nil
		}
		if l < r {
			return -1, nil
		}
	}
	return 0, nil
}
func runtimePlatform() string {
	switch runtime.GOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "macos"
	case "linux":
		return "linux"
	default:
		return runtime.GOOS
	}
}
func runtimeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "arm64":
		return "arm64"
	default:
		return runtime.GOARCH
	}
}
func validateManifest(m Manifest, env string) error {
	if m.SchemaVersion != 1 || m.Environment != env ||
		(m.Platform != "windows" && m.Platform != "macos" && m.Platform != "linux") ||
		(m.Arch != "x64" && m.Arch != "arm64") ||
		m.Platform != runtimePlatform() || m.Arch != runtimeArch() ||
		!segmentPattern.MatchString(m.BuildID) || !segmentPattern.MatchString(m.CoreBuildID) ||
		!checksumPattern.MatchString(m.InstallerSHA256) || m.InstallerBytes < 1024*1024 || m.InstallerBytes > maxInstaller ||
		!safeHTTPS(m.InstallerURL) {
		return errors.New("update_manifest_invalid")
	}
	if _, err := compareVersion(m.Version, "0.0.0"); err != nil {
		return err
	}
	if _, err := compareVersion(m.CoreVersion, "0.0.0"); err != nil {
		return err
	}
	if env == "production" && (!productionInstallerURL(m) || !productionVersion.MatchString(m.CoreVersion)) {
		return errors.New("update_installer_source_invalid")
	}
	return nil
}
func (f Feed) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return &http.Client{Timeout: 25 * time.Second}
}
func readLimited(ctx context.Context, c *http.Client, address string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.Request.URL.Scheme != "https" || res.StatusCode != http.StatusOK || res.ContentLength > limit {
		return nil, errors.New("update_download_rejected")
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("update_download_too_large")
	}
	return raw, nil
}
func (f Feed) verify(raw []byte, signature string) (Manifest, error) {
	var m Manifest
	if err := f.Validate(); err != nil {
		return m, err
	}
	key, _ := base64.StdEncoding.DecodeString(f.Config.PublicKey)
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(ed25519.PublicKey(key), raw, sig) {
		return m, errors.New("update_signature_invalid")
	}
	if err := decode(raw, &m); err != nil {
		return m, errors.New("update_manifest_invalid")
	}
	if err := validateManifest(m, f.Config.Environment); err != nil {
		return m, err
	}
	return m, nil
}
func (f Feed) Check(ctx context.Context, current string) (*SignedRelease, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	if _, err := compareVersion(current, "0.0.0"); err != nil {
		return nil, err
	}
	client := f.downloadClient(false)
	raw, err := readLimited(ctx, client, f.Config.FeedURL, maxMetadata)
	if err != nil {
		return nil, err
	}
	sig, err := readLimited(ctx, client, f.Config.FeedURL+".sig", maxSignature)
	if err != nil {
		return nil, err
	}
	m, err := f.verify(raw, string(sig))
	if err != nil {
		return nil, err
	}
	newer, err := compareVersion(m.Version, current)
	if err != nil {
		return nil, err
	}
	if newer <= 0 {
		return nil, nil
	}
	return &SignedRelease{Manifest: m, Raw: raw, Signature: strings.TrimSpace(string(sig))}, nil
}

// Stage downloads the signed installer to an independent per-user directory.
// It performs no installation, shell exit, Core stop or active pointer change.
func (f Feed) Stage(ctx context.Context, rel SignedRelease, root string) (string, error) {
	return f.StageWithProgress(ctx, rel, root, nil)
}

// StageWithProgress reports byte counts only. No account, URL or filesystem
// information is sent to the renderer; cancellation never stops Core.
func (f Feed) StageWithProgress(ctx context.Context, rel SignedRelease, root string, progress func(DownloadProgress)) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if _, err := f.verify(rel.Raw, rel.Signature); err != nil {
		return "", err
	}
	if err := validateManifest(rel.Manifest, f.Config.Environment); err != nil {
		return "", err
	}
	var signed Manifest
	if err := decode(rel.Raw, &signed); err != nil {
		return "", err
	}
	if signed != rel.Manifest {
		return "", errors.New("update_release_changed")
	}
	newer, err := compareVersion(signed.Version, f.Config.CurrentVersion)
	if err != nil || newer <= 0 {
		return "", errors.New("update_version_not_newer")
	}
	if !filepath.IsAbs(root) {
		return "", errors.New("update_stage_root_invalid")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(root, "release-")
	if err != nil {
		return "", err
	}
	fail := func(err error) (string, error) { _ = os.RemoveAll(stage); return "", err }
	for name, content := range map[string][]byte{"release.json": rel.Raw, "release.sig": []byte(rel.Signature)} {
		if err := os.WriteFile(filepath.Join(stage, name), content, 0600); err != nil {
			return fail(err)
		}
	}
	// Strict redirect rule and streaming size/hash check, so a corrupted
	// download never becomes a launchable setup.exe.
	client := f.downloadClient(true)
	if f.Client == nil {
		client.Timeout = 15 * time.Minute
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rel.Manifest.InstallerURL, nil)
	if err != nil {
		return fail(err)
	}
	res, err := client.Do(req)
	if err != nil {
		return fail(err)
	}
	if res.StatusCode != http.StatusOK || res.Request.URL.Scheme != "https" || res.ContentLength > rel.Manifest.InstallerBytes {
		res.Body.Close()
		return fail(errors.New("update_installer_download_rejected"))
	}
	file, err := os.OpenFile(filepath.Join(stage, "setup.partial"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		res.Body.Close()
		return fail(err)
	}
	hash := sha256.New()
	reader := &downloadReader{ctx: ctx, reader: io.LimitReader(res.Body, rel.Manifest.InstallerBytes+1), total: rel.Manifest.InstallerBytes, notify: progress}
	reader.report("downloading", true)
	n, copyErr := io.Copy(io.MultiWriter(file, hash), reader)
	syncErr := file.Sync()
	closeErr := file.Close()
	bodyErr := res.Body.Close()
	if copyErr != nil {
		return fail(copyErr)
	}
	if syncErr != nil {
		return fail(syncErr)
	}
	if closeErr != nil {
		return fail(closeErr)
	}
	if bodyErr != nil {
		return fail(bodyErr)
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	reader.report("verifying", true)
	if n != rel.Manifest.InstallerBytes || hex.EncodeToString(hash.Sum(nil)) != rel.Manifest.InstallerSHA256 {
		return fail(errors.New("update_installer_integrity_failed"))
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	if err := os.Rename(filepath.Join(stage, "setup.partial"), filepath.Join(stage, "setup.exe")); err != nil {
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	return stage, nil
}

// VerifyStage repeats signature, exact size and SHA-256 checks immediately
// before the detached helper runs the installer (TOCTOU guard).
func (f Feed) VerifyStage(stage string) (Manifest, string, error) {
	var zero Manifest
	raw, err := os.ReadFile(filepath.Join(stage, "release.json"))
	if err != nil {
		return zero, "", err
	}
	if len(raw) > maxMetadata {
		return zero, "", errors.New("update_manifest_invalid")
	}
	sig, err := os.ReadFile(filepath.Join(stage, "release.sig"))
	if err != nil {
		return zero, "", err
	}
	if len(sig) > maxSignature {
		return zero, "", errors.New("update_signature_invalid")
	}
	m, err := f.verify(raw, string(sig))
	if err != nil {
		return zero, "", err
	}
	newer, err := compareVersion(m.Version, f.Config.CurrentVersion)
	if err != nil {
		return zero, "", err
	}
	if newer <= 0 {
		return zero, "", errors.New("update_version_not_newer")
	}
	installer := filepath.Join(stage, "setup.exe")
	file, err := os.Open(installer)
	if err != nil {
		return zero, "", err
	}
	hasher := sha256.New()
	count, copyErr := io.Copy(hasher, io.LimitReader(file, m.InstallerBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		return zero, "", copyErr
	}
	if closeErr != nil {
		return zero, "", closeErr
	}
	if count != m.InstallerBytes || hex.EncodeToString(hasher.Sum(nil)) != m.InstallerSHA256 {
		return zero, "", errors.New("update_installer_integrity_failed")
	}
	return m, installer, nil
}

// Update packages stay beneath the one user-data root, outside the installed
// shell. Channel subfolders hold downloads only, never separate user databases.
func DefaultStageRoot(environment string) (string, error) {
	if environment != "test" && environment != "production" {
		return "", errors.New("update_environment_invalid")
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return "", errors.New("user_home_must_be_absolute")
	}
	return filepath.Join(home, ".blackhole", "updates", environment), nil
}
func (m Manifest) Label() string { return fmt.Sprintf("%s (%s)", m.Version, m.BuildID) }
