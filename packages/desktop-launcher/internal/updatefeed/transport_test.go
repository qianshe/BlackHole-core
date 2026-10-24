package updatefeed

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
)

func TestProductionDownloadMustMatchGitHubRepoAndVersion(t *testing.T) {
	base := "https://github.com/qianshe/BlackHole-core/releases/download/v0.3.202/BlackHole-0.3.202-windows-x64-setup.exe"
	m := Manifest{Version: "0.3.202", InstallerURL: base}
	if !productionInstallerURL(m) {
		t.Fatal("release asset rejected")
	}
	for _, u := range []string{
		strings.Replace(base, "qianshe/BlackHole-core", "other/repo", 1), strings.Replace(base, "v0.3.202/", "v0.3.201/", 1),
		strings.Replace(base, "github.com", "github.com.evil.invalid", 1), strings.Replace(base, "https://", "http://", 1),
		strings.Replace(base, "/download/v0.3.202/", "/latest/download/", 1), base + "?token=secret", base + "#ignored",
		strings.Replace(base, "BlackHole-0.3.202-windows-x64-setup.exe", "BlackHole-test-unsigned.exe", 1),
		strings.Replace(base, "https://github.com", "https://user@github.com", 1), strings.Replace(base, "qianshe", "%71ianshe", 1),
	} {
		m.InstallerURL = u
		if productionInstallerURL(m) {
			t.Fatal("unsafe release URL accepted", u)
		}
	}
}
func TestGitHubCDNRedirectAllowsSignedQueryWithoutAccountCookies(t *testing.T) {
	jar, _ := cookiejar.New(nil)
	origin, _ := url.Parse("https://github.com")
	jar.SetCookies(origin, []*http.Cookie{{Name: "synthetic-account-cookie", Value: "must-not-send", Path: "/"}})
	hops := 0
	base := &http.Client{Jar: jar, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		hops++
		for _, name := range []string{"Authorization", "Cookie", "Referer", "Proxy-Authorization"} {
			if r.Header.Get(name) != "" {
				t.Errorf("download leaked %s", name)
			}
		}
		if r.URL.Host == "github.com" {
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://release-assets.githubusercontent.com/asset?signature=synthetic"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		if r.URL.Host != "release-assets.githubusercontent.com" || r.URL.Query().Get("signature") != "synthetic" {
			t.Errorf("unexpected CDN URL %s", r.URL.Host)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("fixture")), Request: r}, nil
	})}
	f := Feed{Config: Config{Environment: "production", FeedURL: "https://cloud.example.invalid/latest.json"}, Client: base}
	response, err := f.downloadClient(true).Get("https://github.com/qianshe/BlackHole-core/releases/download/v0.3.202/BlackHole-setup.exe")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if hops != 2 {
		t.Fatal(hops)
	}
	if base.Jar == nil {
		t.Fatal("caller client mutated")
	}
}
func TestRedirectToMirrorOrHTTPIsRejectedBeforeRequest(t *testing.T) {
	for _, destination := range []string{"http://release-assets.githubusercontent.com/file", "https://evil.example.invalid/file", "https://user:password@release-assets.githubusercontent.com/file"} {
		calls := 0
		f := Feed{Config: Config{Environment: "production"}, Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{destination}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		})}}
		if _, err := f.downloadClient(true).Get("https://github.com/qianshe/BlackHole-core/releases/download/v0.3.202/BlackHole-setup.exe"); err == nil {
			t.Fatal("redirect accepted")
		}
		if calls != 1 {
			t.Fatal("unsafe host contacted", calls)
		}
	}
}
func TestPostponedPackageMustStillBePublished(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	if err := f.ConfirmRelease(context.Background(), *rel); err != nil {
		t.Fatal(err)
	}
	if dir, err := f.Stage(context.Background(), *rel, t.TempDir()); err != nil || dir == "" {
		t.Fatal(err)
	}
	f.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":"release_unavailable"}`)), Request: r}, nil
	})}
	if err := f.ConfirmRelease(context.Background(), *rel); err == nil {
		t.Fatal("withdrawn release permitted installation")
	}
}
func TestFreshlySignedChangedReleaseCannotInstallTheOldDownload(t *testing.T) {
	f, rel, _, closeServer := fixture(t)
	defer closeServer()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.Config.PublicKey = base64.StdEncoding.EncodeToString(pub)
	rel.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, rel.Raw))
	next := rel.Manifest
	next.BuildID = "replacement-build"
	nextRaw, _ := json.Marshal(next)
	nextSig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, nextRaw))
	f.Client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		raw := string(nextRaw)
		if strings.HasSuffix(r.URL.Path, ".sig") {
			raw = nextSig
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw)), Request: r}, nil
	})}
	if err := f.ConfirmRelease(context.Background(), *rel); err == nil || err.Error() != "update_release_changed" {
		t.Fatal(err)
	}
}
