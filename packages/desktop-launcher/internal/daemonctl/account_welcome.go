package daemonctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// WelcomeStatus is the only account information the Desktop welcome bridge
// receives. Neither credentials, account identifiers nor OAuth URLs appear.
type WelcomeStatus struct {
	State  string `json:"state"`
	SignIn struct {
		State string `json:"state"`
		Error string `json:"error,omitempty"`
	} `json:"signIn"`
}

func validWelcomeStatus(v WelcomeStatus) bool {
	switch v.State {
	case "checking", "verified", "saved", "logged_out", "unavailable":
	default:
		return false
	}
	switch v.SignIn.State {
	case "idle", "running", "done", "failed":
		return true
	}
	return false
}

func (c Client) accountHTTP(ctx context.Context, method, route string) (*http.Response, error) {
	hc := c.HTTP
	if hc == nil {
		timeout := 5 * time.Second
		if route == "call" {
			timeout = 20 * time.Second // Core session verification may take 15s.
		}
		hc = &http.Client{Timeout: timeout}
	}
	// The target is fixed to a loopback port supplied by the attached Core.
	// UI content cannot choose another address, route, method or JSON body.
	body := "{}"
	if route == "call" {
		body = `{"method":"check","args":[]}`
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+strconv.Itoa(c.Port)+"/api/account/"+route, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	return hc.Do(request)
}

func (c Client) Welcome(ctx context.Context) (WelcomeStatus, error) {
	var state WelcomeStatus
	response, err := c.accountHTTP(ctx, http.MethodGet, "welcome")
	if err != nil {
		return state, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return state, fmt.Errorf("welcome_status_http_%d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2048)).Decode(&state); err != nil || !validWelcomeStatus(state) {
		return state, errors.New("welcome_status_invalid")
	}
	return state, nil
}

// LoginAction requests native Core authentication, never a browser/Web login.
// Only explicit, no-argument sign-in/cancel actions are allowed.
func (c Client) LoginAction(ctx context.Context, action string) (WelcomeStatus, error) {
	var state WelcomeStatus
	var route string
	switch action {
	case "sign-in":
		route = "sign-in"
	case "cancel":
		route = "sign-in/cancel"
	case "verify":
		route = "call"
	default:
		return state, errors.New("invalid_welcome_action")
	}
	response, err := c.accountHTTP(ctx, http.MethodPost, route)
	if err != nil {
		return state, err
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return state, fmt.Errorf("welcome_login_http_%d", response.StatusCode)
	}
	return c.Welcome(ctx)
}
