package updatefeed

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var releaseFilename = regexp.MustCompile(`^BlackHole-[A-Za-z0-9._-]+\.exe\z`)
var productionVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\z`)

// Production downloads are version-addressed assets from our public release
// repository, never source archives, latest aliases, CI artifacts or mirrors.
// Test feeds may use a synthetic HTTPS endpoint, but never a production identity.
func productionInstallerURL(m Manifest) bool {
	u, err := url.Parse(m.InstallerURL)
	if err != nil || !productionVersion.MatchString(m.Version) || !safeHTTPS(m.InstallerURL) || u.Host != "github.com" || u.RawPath != "" {
		return false
	}
	prefix := "/qianshe/BlackHole-core/releases/download/v" + m.Version + "/"
	if !strings.HasPrefix(u.Path, prefix) {
		return false
	}
	name := strings.TrimPrefix(u.Path, prefix)
	lower := strings.ToLower(name)
	return releaseFilename.MatchString(name) && !strings.Contains(lower, "unsigned") && !strings.Contains(lower, "test") && !strings.Contains(lower, "candidate")
}

// A CDN redirect may contain a short-lived signed query. That query belongs to
// GitHub's delivery URL, not our canonical manifest, and must not be logged.
func safeRedirectURL(u *url.URL) bool {
	return u != nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" && u.Opaque == ""
}
func githubDownloadHost(u *url.URL) bool {
	if !safeRedirectURL(u) || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	default:
		return false
	}
}

func (f Feed) downloadClient(artifact bool) *http.Client {
	client := *f.client()
	client.Jar = nil // Download/check requests never inherit account cookies.
	original := client.CheckRedirect
	initial, _ := url.Parse(f.Config.FeedURL)
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if !safeRedirectURL(req.URL) || len(via) > 5 {
			return errors.New("update_redirect_rejected")
		}
		if f.Config.Environment == "production" {
			if artifact {
				if !githubDownloadHost(req.URL) {
					return errors.New("update_redirect_rejected")
				}
			} else if initial == nil || req.URL.Host != initial.Host {
				return errors.New("update_redirect_rejected")
			}
		}
		// Do not leak either Cloud URLs or host credentials across a redirect.
		for _, key := range []string{"Authorization", "Proxy-Authorization", "Cookie", "Referer"} {
			req.Header.Del(key)
		}
		if original != nil {
			return original(req, via)
		}
		return nil
	}
	return &client
}

// ConfirmRelease is a fresh network verification before any process exit. A
// staged package is not permission to install a release withdrawn since download.
func (f Feed) ConfirmRelease(ctx context.Context, want SignedRelease) error {
	verified, err := f.verify(want.Raw, want.Signature)
	if err != nil {
		return err
	}
	if verified != want.Manifest {
		return errors.New("update_release_changed")
	}
	latest, err := f.Check(ctx, f.Config.CurrentVersion)
	if err != nil {
		return err
	}
	if latest == nil || latest.Manifest != want.Manifest {
		return errors.New("update_release_changed")
	}
	return nil
}
