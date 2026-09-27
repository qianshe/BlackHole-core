package daemonctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var ticketRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// WebURL asks the daemon for a one-time signed-in URL of the local Web UI.
// The ticket lives in the fragment, so it never reaches server logs.
func (c Client) WebURL(ctx context.Context) (string, error) {
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(c.Port)+"/api/web/bootstrap", strings.NewReader("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/json")
	res, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		Ticket string `json:"ticket"`
		Path   string `json:"path"`
		Error  string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body)
	if res.StatusCode == http.StatusNotFound {
		return "", errors.New("正在运行的 BlackHole 版本较旧，不支持网页界面。请把 VS Code 扩展更新到最新版，并重启 BlackHole 后再试。")
	}
	if res.StatusCode != http.StatusOK || !ticketRe.MatchString(body.Ticket) || body.Path != "/ui/" {
		code := body.Error
		if code == "" {
			code = strconv.Itoa(res.StatusCode)
		}
		return "", fmt.Errorf("无法获取登录凭证（%s）", code)
	}
	return "http://127.0.0.1:" + strconv.Itoa(c.Port) + body.Path + "#" + body.Ticket, nil
}

// ValidWebURL guards the window process: it only ever opens a local ticket URL.
func ValidWebURL(u string) bool {
	rest, ok := strings.CutPrefix(u, "http://127.0.0.1:")
	if !ok {
		return false
	}
	port, frag, ok := strings.Cut(rest, "/ui/#")
	p, err := strconv.Atoi(port)
	return ok && err == nil && p > 0 && p < 65536 && ticketRe.MatchString(frag)
}
