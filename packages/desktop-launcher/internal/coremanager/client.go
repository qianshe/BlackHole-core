// Package coremanager is a bounded JSON transport to the host-neutral Manager.
// It never discovers Node on PATH, edits the Core store, spawns a daemon itself,
// retries an ambiguous mutation, or falls back to the legacy bootstrap.
package coremanager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const MaxMessageBytes = 1024 * 1024

// These absolute paths must come from the verified installer/provisioner.
// Distribution verifies compiler-pinned bootstrap files; this transport never
// discovers a runtime or implements Core selection policy.
type Client struct {
	Node, Entry, Store, TrustConfig string
	Env                             []string // nil inherits the environment; tests use isolated roots.
	Timeout                         time.Duration
}

type ManagerError struct{ Code, Message string }

func (e *ManagerError) Error() string { return e.Code + ": " + e.Message }

// UnknownOutcome means the caller must inspect/reconcile state, not retry
// attach with another port/runtime. Even an invalid response may follow spawn.
type UnknownOutcome struct{ Reason string }

func (e *UnknownOutcome) Error() string { return "manager_outcome_unknown: " + e.Reason }

type Protocol struct {
	Min int `json:"min"`
	Max int `json:"max"`
}
type Host struct {
	ClientID     string   `json:"clientId"`
	InstanceID   string   `json:"clientInstanceId"`
	Kind         string   `json:"kind"`
	Version      string   `json:"version"`
	Protocol     Protocol `json:"protocol"`
	Capabilities []string `json:"capabilities"`
}
type Receipt struct {
	ProtocolVersion  int      `json:"protocolVersion"`
	InstanceKey      string   `json:"instanceKey"`
	DaemonID         string   `json:"daemonId"`
	DaemonVersion    string   `json:"daemonVersion"`
	RuntimeKind      string   `json:"runtimeKind"`
	UIVersion        string   `json:"uiVersion"`
	ConfigRevision   int      `json:"configRevision"`
	LocalURL         string   `json:"localUrl"`
	WebAPIBase       string   `json:"webApiBase"`
	Capabilities     []string `json:"capabilities"`
	RuntimeID        string   `json:"runtimeId"`
	RuntimeVersion   string   `json:"runtimeVersion"`
	BuildID          string   `json:"buildId"`
	DescriptorHash   string   `json:"descriptorHash"`
	DataRootID       string   `json:"dataRootId"`
	WebBuildID       string   `json:"webBuildId"`
	CoreProtocol     Protocol `json:"coreProtocol"`
	Environment      string   `json:"environment"`
	CloudOrigin      string   `json:"cloudOrigin"`
	LifecycleState   string   `json:"lifecycleState"`
	StartFingerprint string   `json:"startFingerprint"`
}
type Lease struct {
	SchemaVersion  int    `json:"schemaVersion"`
	LeaseID        string `json:"leaseId"`
	ClientID       string `json:"clientId"`
	InstanceID     string `json:"clientInstanceId"`
	Kind           string `json:"kind"`
	RuntimeID      string `json:"runtimeId"`
	BuildID        string `json:"buildId"`
	DescriptorHash string `json:"descriptorHash"`
	DataRootID     string `json:"dataRootId"`
	DaemonID       string `json:"daemonId"`
	IssuedAt       string `json:"issuedAt"`
	ExpiresAt      string `json:"expiresAt"`
}
type Handle struct {
	LeaseID        string `json:"leaseId"`
	InstanceID     string `json:"clientInstanceId"`
	DaemonID       string `json:"daemonId"`
	DataRootID     string `json:"dataRootId"`
	DescriptorHash string `json:"descriptorHash"`
}

func (l Lease) Handle() Handle {
	return Handle{l.LeaseID, l.InstanceID, l.DaemonID, l.DataRootID, l.DescriptorHash}
}

type Attachment struct {
	Receipt Receipt `json:"receipt"`
	Lease   Lease   `json:"lease"`
	Spawned bool    `json:"spawned"`
}

type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	room := MaxMessageBytes + 1 - b.Len()
	if room > 0 {
		if len(p) > room {
			p = p[:room]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}
func decode(data []byte, value any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func (c Client) invoke(ctx context.Context, request any, result any) error {
	for _, p := range []string{c.Node, c.Entry, c.Store, c.TrustConfig} {
		if !filepath.IsAbs(p) {
			return errors.New("manager_absolute_paths_required")
		}
	}
	input, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if len(input) > MaxMessageBytes {
		return errors.New("manager_request_too_large")
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Node, c.Entry)
	env := c.Env
	if env == nil {
		env = os.Environ()
	}
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "BH_CORE_STORE", "BH_CORE_TRUST_CONFIG":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "BH_CORE_STORE="+c.Store, "BH_CORE_TRUST_CONFIG="+c.TrustConfig)
	cmd.Stdin = bytes.NewReader(input)
	out := &boundedBuffer{}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	hideWindow(cmd)
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return &UnknownOutcome{Reason: "request cancelled or timed out"}
	}
	if out.Len() > MaxMessageBytes {
		return &UnknownOutcome{Reason: "response exceeds limit"}
	}
	var response struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if decode(out.Bytes(), &response) != nil {
		return &UnknownOutcome{Reason: "invalid JSON response"}
	}
	if !response.OK {
		if response.Error == nil || response.Error.Code == "" || len(response.Error.Code) > 200 || len(response.Error.Message) > 2000 || len(response.Result) > 0 {
			return &UnknownOutcome{Reason: "invalid error response"}
		}
		return &ManagerError{Code: response.Error.Code, Message: response.Error.Message}
	}
	if runErr != nil || response.Error != nil || len(response.Result) == 0 || decode(response.Result, result) != nil {
		return &UnknownOutcome{Reason: "invalid success response"}
	}
	return nil
}

var hashPattern = regexp.MustCompile("^[a-f0-9]{64}$")
var uuidPattern = regexp.MustCompile("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

func validLease(l Lease) bool {
	issued, e1 := time.Parse(time.RFC3339Nano, l.IssuedAt)
	expires, e2 := time.Parse(time.RFC3339Nano, l.ExpiresAt)
	return l.SchemaVersion == 1 && uuidPattern.MatchString(l.LeaseID) && uuidPattern.MatchString(l.InstanceID) && l.ClientID != "" && (l.Kind == "desktop" || l.Kind == "vscode") && l.RuntimeID != "" && l.BuildID != "" && l.DaemonID != "" && hashPattern.MatchString(l.DataRootID) && hashPattern.MatchString(l.DescriptorHash) && e1 == nil && e2 == nil && expires.After(issued)
}
func validHandle(h Handle) bool {
	return uuidPattern.MatchString(h.LeaseID) && uuidPattern.MatchString(h.InstanceID) && h.DaemonID != "" && hashPattern.MatchString(h.DataRootID) && hashPattern.MatchString(h.DescriptorHash)
}
func (c Client) Attach(ctx context.Context, host Host, port int) (Attachment, error) {
	return c.attach(ctx, host, port, "")
}
func (c Client) AttachExisting(ctx context.Context, host Host, port int, fingerprint string) (Attachment, error) {
	if fingerprint == "" || len(fingerprint) > 500 {
		return Attachment{}, errors.New("manager_request_invalid")
	}
	return c.attach(ctx, host, port, fingerprint)
}
func (c Client) attach(ctx context.Context, host Host, port int, fingerprint string) (Attachment, error) {
	var out Attachment
	if port < 1 || port > 65535 || !uuidPattern.MatchString(host.InstanceID) || host.ClientID == "" || host.Version == "" || (host.Kind != "desktop" && host.Kind != "vscode") || host.Protocol.Min < 1 || host.Protocol.Max < host.Protocol.Min {
		return out, errors.New("manager_request_invalid")
	}
	if host.Capabilities == nil {
		host.Capabilities = []string{}
	}
	request := map[string]any{"client": host, "port": port}
	if fingerprint != "" {
		request["existingFingerprint"] = fingerprint
	}
	err := c.invoke(ctx, map[string]any{"command": "attach-or-start", "request": request}, &out)
	if err != nil {
		return Attachment{}, err
	}
	if fingerprint != "" && (out.Spawned || out.Receipt.StartFingerprint != fingerprint) {
		return Attachment{}, &UnknownOutcome{Reason: "existing_target_mismatch"}
	}
	if err := validateAttachment(out, host, port); err != nil {
		return Attachment{}, err
	}
	return out, nil
}
func validateAttachment(out Attachment, host Host, port int) error {
	r, l := out.Receipt, out.Lease
	if !validLease(l) || l.ClientID != host.ClientID || l.InstanceID != host.InstanceID || l.Kind != host.Kind || r.DaemonID != l.DaemonID || r.RuntimeID != l.RuntimeID || r.BuildID != l.BuildID || r.DataRootID != l.DataRootID || r.DescriptorHash != l.DescriptorHash || r.InstanceKey != r.DataRootID || r.StartFingerprint == "" || r.RuntimeVersion == "" || r.DaemonVersion == "" || r.WebBuildID == "" || r.UIVersion != r.WebBuildID || r.CloudOrigin == "" || r.ConfigRevision < 0 || r.LifecycleState != "managed" || r.RuntimeKind != "standalone-node" || (r.Environment != "test" && r.Environment != "production") || r.ProtocolVersion < host.Protocol.Min || r.ProtocolVersion > host.Protocol.Max || r.ProtocolVersion < r.CoreProtocol.Min || r.ProtocolVersion > r.CoreProtocol.Max || r.CoreProtocol.Min < 1 || r.CoreProtocol.Max < r.CoreProtocol.Min || r.WebAPIBase != "../web-api/v1/" || r.LocalURL != "http://127.0.0.1:"+strconv.Itoa(port)+"/ui/" {
		return &UnknownOutcome{Reason: "receipt/lease target mismatch"}
	}
	for _, required := range host.Capabilities {
		found := false
		for _, capability := range r.Capabilities {
			if capability == required {
				found = true
			}
		}
		if !found {
			return &UnknownOutcome{Reason: "required capability missing"}
		}
	}
	return nil
}
func (c Client) Heartbeat(ctx context.Context, handle Handle, port int) (Lease, error) {
	if !validHandle(handle) || port < 1 || port > 65535 {
		return Lease{}, errors.New("manager_request_invalid")
	}
	var out Lease
	if err := c.invoke(ctx, map[string]any{"command": "heartbeat", "request": map[string]any{"handle": handle, "port": port}}, &out); err != nil {
		return Lease{}, err
	}
	if !validLease(out) || out.Handle() != handle {
		return Lease{}, &UnknownOutcome{Reason: "renewed lease target mismatch"}
	}
	return out, nil
}
func (c Client) Detach(ctx context.Context, handle Handle) error {
	if !validHandle(handle) {
		return errors.New("manager_request_invalid")
	}
	var out struct {
		Detached bool `json:"detached"`
	}
	if err := c.invoke(ctx, map[string]any{"command": "detach", "handle": handle}, &out); err != nil {
		return err
	}
	if !out.Detached {
		return &UnknownOutcome{Reason: "detach not confirmed"}
	}
	return nil
}

type UpgradeResult struct {
	Operation       string     `json:"operation"`
	RequestID       string     `json:"requestId"`
	State           string     `json:"state"`
	FromVersionName string     `json:"fromVersionName"`
	TargetVersion   string     `json:"targetVersionName"`
	Attachment      Attachment `json:"attachment"`
}

// Upgrade runs the journalled Manager transaction: guarded stop of the old
// Core, pointer switch, candidate start/verify, and rollback on a positively
// failed candidate. A rolled_back result returns the previous Core's fresh
// attachment; callers must not treat it as a completed upgrade.
func (c Client) Upgrade(ctx context.Context, host Host, port int, handle Handle, requestID, targetVersionName, targetDescriptorHash string) (UpgradeResult, error) {
	var out UpgradeResult
	if !validHandle(handle) || !uuidPattern.MatchString(requestID) || port < 1 || port > 65535 || targetVersionName == "" || len(targetVersionName) > 250 || targetDescriptorHash == "" || host.ClientID == "" || host.Version == "" || !uuidPattern.MatchString(host.InstanceID) {
		return out, errors.New("manager_request_invalid")
	}
	if host.Capabilities == nil {
		host.Capabilities = []string{}
	}
	request := map[string]any{"handle": handle, "client": host, "port": port, "confirmed": true, "requestId": requestID, "targetVersionName": targetVersionName, "readyTimeoutMs": 30000}
	if err := c.invoke(ctx, map[string]any{"command": "upgrade-core", "request": request}, &out); err != nil {
		return UpgradeResult{}, err
	}
	if out.Operation != "upgrade" || out.RequestID != requestID || out.TargetVersion != targetVersionName || out.FromVersionName == "" || out.FromVersionName == targetVersionName || (out.State != "committed" && out.State != "rolled_back") {
		return UpgradeResult{}, &UnknownOutcome{Reason: "upgrade result mismatch"}
	}
	attachment := out.Attachment
	if err := validateAttachment(attachment, host, port); err != nil {
		return UpgradeResult{}, err
	}
	if attachment.Receipt.DataRootID != handle.DataRootID || attachment.Receipt.DaemonID == handle.DaemonID || attachment.Lease.LeaseID == handle.LeaseID {
		return UpgradeResult{}, &UnknownOutcome{Reason: "upgrade incarnation mismatch"}
	}
	if out.State == "committed" && attachment.Receipt.DescriptorHash != targetDescriptorHash {
		return UpgradeResult{}, &UnknownOutcome{Reason: "upgrade target mismatch"}
	}
	if out.State == "rolled_back" && (attachment.Receipt.DescriptorHash == targetDescriptorHash || attachment.Receipt.DescriptorHash != handle.DescriptorHash) {
		return UpgradeResult{}, &UnknownOutcome{Reason: "upgrade rollback mismatch"}
	}
	return out, nil
}

// KeepAlive owns only this attachment's lease. A heartbeat error disconnects
// the client; cancellation/return attempts local detach with a fresh timeout.
// Neither failure nor the last client leaving ever stops the shared daemon.
func (c Client) KeepAlive(ctx context.Context, handle Handle, port int) (err error) {
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if detachErr := c.Detach(cleanup, handle); detachErr != nil {
			err = errors.Join(err, fmt.Errorf("detach: %w", detachErr))
		}
	}()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if _, err = c.Heartbeat(ctx, handle, port); err != nil {
				return err
			}
		}
	}
}
