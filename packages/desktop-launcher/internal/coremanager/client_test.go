package coremanager

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

const testUUID = "11111111-1111-4111-8111-111111111111"
const leaseUUID = "22222222-2222-4222-8222-222222222222"

var testHash = strings.Repeat("a", 64)

func testHost() Host {
	return Host{ClientID: "desktop", InstanceID: testUUID, Kind: "desktop", Version: "1", Protocol: Protocol{1, 1}, Capabilities: []string{"web-ui"}}
}
func testReceipt() Receipt {
	return Receipt{ProtocolVersion: 1, InstanceKey: testHash, DaemonID: "daemon", DaemonVersion: "1", RuntimeKind: "standalone-node", UIVersion: "web", LocalURL: "http://127.0.0.1:49199/ui/", WebAPIBase: "../web-api/v1/", Capabilities: []string{"web-ui"}, RuntimeID: "core", RuntimeVersion: "1", BuildID: "build", DescriptorHash: testHash, DataRootID: testHash, WebBuildID: "web", CoreProtocol: Protocol{1, 1}, Environment: "test", CloudOrigin: "https://fixture.invalid", LifecycleState: "managed", StartFingerprint: "fingerprint"}
}
func testLease() Lease {
	return Lease{SchemaVersion: 1, LeaseID: leaseUUID, ClientID: "desktop", InstanceID: testUUID, Kind: "desktop", RuntimeID: "core", BuildID: "build", DescriptorHash: testHash, DataRootID: testHash, DaemonID: "daemon", IssuedAt: "2026-10-12T00:00:00Z", ExpiresAt: "2026-10-12T00:00:45Z"}
}

func TestMain(m *testing.M) {
	if os.Getenv("BH_TEST_COREMANAGER_HELPER") != "1" {
		os.Exit(m.Run())
	}
	if os.Getenv("NODE_OPTIONS") != "" || os.Getenv("NODE_PATH") != "" || os.Getenv("ELECTRON_RUN_AS_NODE") != "" {
		os.Exit(9)
	}
	input, _ := io.ReadAll(io.LimitReader(os.Stdin, MaxMessageBytes+1))
	if file := os.Getenv("BH_TEST_CALLS"); file != "" {
		f, _ := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
		if f != nil {
			_, _ = f.Write(append(input, '\n'))
			_ = f.Close()
		}
	}
	mode := os.Getenv("BH_TEST_MODE")
	switch mode {
	case "malformed":
		_, _ = os.Stdout.WriteString("SECRET-MUST-NOT-LEAK")
		_, _ = os.Stderr.WriteString("SECRET-STDERR")
		os.Exit(0)
	case "oversized":
		_, _ = os.Stdout.WriteString(strings.Repeat("x", MaxMessageBytes+20))
		os.Exit(0)
	case "slow":
		time.Sleep(10 * time.Second)
		os.Exit(0)
	case "error":
		_, _ = os.Stdout.WriteString(`{"ok":false,"error":{"code":"lock_busy","message":"another Manager owns the lock"}}`)
		os.Exit(1)
	}
	var request struct {
		Command string `json:"command"`
	}
	_ = json.Unmarshal(input, &request)
	var result any
	var document struct {
		Request struct {
			Operation           string
			RequestID           string
			CurrentFingerprint  string
			ExistingFingerprint string
			Port                int
			VersionName         string
			DescriptorHash      string
		}
	}
	_ = json.Unmarshal(input, &document)
	switch request.Command {
	case "resolve-endpoint":
		result = Endpoint{SchemaVersion: 1, DataRootID: testHash, Port: 49199, Revision: 3}
		if mode == "bad-endpoint" {
			result = Endpoint{SchemaVersion: 1, DataRootID: "wrong", Port: 49199, Revision: 3}
		}
	case "configure-endpoint":
		result = Endpoint{SchemaVersion: 1, DataRootID: testHash, Port: document.Request.Port, Revision: 4}
	case "inspect-start":
		// A real record now carries the OS boot generation. The Go decoder
		// rejects unknown fields, so this fixture must stay in step with the
		// TypeScript schema; otherwise every start/stop/repair command breaks.
		r := testReceipt()
		result = StartState{SchemaVersion: 1, Status: "ready", PID: 4321, VersionName: "1.0.0-build",
			DescriptorHash: testHash, DataRootID: testHash, DBPath: filepath.Join("home", ".blackhole", "blackhole.db"),
			Port: 49199, StartFingerprint: r.StartFingerprint, Receipt: &r,
			BootID: "boot-generation-1"}
		if mode == "legacy-start-record" {
			result = StartState{SchemaVersion: 1, Status: "ready", PID: 4321, VersionName: "1.0.0-build",
				DescriptorHash: testHash, DataRootID: testHash, DBPath: filepath.Join("home", ".blackhole", "blackhole.db"),
				Port: 49199, StartFingerprint: r.StartFingerprint, Receipt: &r}
		}
	case "inspect-maintenances":
		result = []MaintenanceRecord{}
	case "recover-maintenance":
		r := map[string]any{"recovered": true, "restarted": false, "requestId": document.Request.RequestID}
		if document.Request.CurrentFingerprint != "" {
			r["observed"] = "running"
		}
		result = r
	case "maintain-core":
		r, l := testReceipt(), testLease()
		r.DaemonID = "replacement"
		r.StartFingerprint = "new-fingerprint"
		l.DaemonID = r.DaemonID
		l.LeaseID = "33333333-3333-4333-8333-333333333333"
		if mode == "wrong-replacement" {
			r.BuildID = "foreign"
			l.BuildID = "foreign"
		}
		if mode == "stale-replacement" {
			r = testReceipt()
			l = testLease()
		}
		m := MaintenanceResult{Operation: document.Request.Operation, RequestID: document.Request.RequestID, Stopped: true}
		if m.Operation == "restart" && mode != "missing-attachment" {
			m.Attachment = &Attachment{Receipt: r, Lease: l}
		}
		if mode == "wrong-request" {
			m.RequestID = testUUID
		}
		result = m

	case "start-bundled-core":
		r, l := testReceipt(), testLease()
		r.RuntimeVersion = "0.4.7"
		r.DaemonVersion = "0.4.7"
		r.DescriptorHash = document.Request.DescriptorHash
		l.DescriptorHash = r.DescriptorHash
		l.ExpiresAt = time.Now().Add(45 * time.Second).Format(time.RFC3339Nano)
		state, reason := "updated", ""
		if mode == "bundle-deferred" {
			r.RuntimeVersion = "0.4.6"
			r.DaemonVersion = "0.4.6"
			state = "deferred"
			reason = "active_work"
		}
		if mode == "bundle-lie" {
			r.RuntimeVersion = "0.4.6"
		}
		result = BundleStart{State: state, Reason: reason, TargetVersion: document.Request.VersionName, Attachment: Attachment{Receipt: r, Lease: l}}
	case "reconnect-core":
		r, l := testReceipt(), testLease()
		r.DaemonID = "new-daemon"
		r.StartFingerprint = "new-fingerprint"
		r.RuntimeVersion = "0.4.7"
		r.DaemonVersion = "0.4.7"
		l.DaemonID = r.DaemonID
		l.LeaseID = "33333333-3333-4333-8333-333333333333"
		l.ExpiresAt = time.Now().Add(45 * time.Second).Format(time.RFC3339Nano)
		if mode == "reconnect-root" {
			r.DataRootID = strings.Repeat("b", 64)
			r.InstanceKey = r.DataRootID
			l.DataRootID = r.DataRootID
		}
		result = Attachment{Receipt: r, Lease: l, Spawned: mode == "reconnect-spawn"}
	case "attach-or-start":
		r := testReceipt()
		if mode == "mismatch" {
			r.DaemonID = "foreign"
		}
		if mode == "remote-url" {
			r.LocalURL = "https://remote.invalid/ui/"
		}
		result = Attachment{Receipt: r, Lease: testLease(), Spawned: document.Request.ExistingFingerprint == ""}
		if mode == "secret" {
			b, _ := json.Marshal(result)
			var raw map[string]any
			_ = json.Unmarshal(b, &raw)
			raw["receipt"].(map[string]any)["ticket"] = "SECRET"
			result = raw
		}
	case "heartbeat":
		result = testLease()
	case "detach":
		result = map[string]bool{"detached": true}
	default:
		os.Exit(8)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "result": result})
	os.Exit(0)
}

func helper(t *testing.T, mode string) (Client, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	calls := filepath.Join(root, "calls.jsonl")
	return Client{Node: exe, Entry: exe, Store: filepath.Join(root, "Core"), TrustConfig: filepath.Join(root, "trust.json"), Timeout: 3 * time.Second,
		Env: append(os.Environ(), "BH_TEST_COREMANAGER_HELPER=1", "BH_TEST_MODE="+mode, "BH_TEST_CALLS="+calls, "NODE_OPTIONS=poison", "NODE_PATH=poison", "ELECTRON_RUN_AS_NODE=1")}, calls
}
func TestBoundedManagerTransportLifecycle(t *testing.T) {
	c, file := helper(t, "")
	ctx := context.Background()
	a, err := c.Attach(ctx, testHost(), 49199)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Spawned || a.Receipt.DaemonID != "daemon" {
		t.Fatal(a)
	}
	if _, err = c.Heartbeat(ctx, a.Lease.Handle(), 49199); err != nil {
		t.Fatal(err)
	}
	if err = c.Detach(ctx, a.Lease.Handle()); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(file)
	if len(strings.Split(strings.TrimSpace(string(body)), "\n")) != 3 {
		t.Fatal("unexpected retries", string(body))
	}
}
func TestManagerFailuresNeverRetryOrLeakOutput(t *testing.T) {
	for _, mode := range []string{"malformed", "oversized", "slow", "mismatch", "remote-url", "secret", "error"} {
		t.Run(mode, func(t *testing.T) {
			c, file := helper(t, mode)
			if mode == "slow" {
				c.Timeout = 300 * time.Millisecond
			}
			_, err := c.Attach(context.Background(), testHost(), 49199)
			if err == nil {
				t.Fatal("expected failure")
			}
			if strings.Contains(err.Error(), "SECRET") {
				t.Fatal("raw child output leaked")
			}
			var unknown *UnknownOutcome
			var known *ManagerError
			if mode == "error" {
				if !errors.As(err, &known) || known.Code != "lock_busy" {
					t.Fatal(err)
				}
			} else if !errors.As(err, &unknown) {
				t.Fatal(err)
			}
			body, _ := os.ReadFile(file)
			if len(strings.Split(strings.TrimSpace(string(body)), "\n")) != 1 {
				t.Fatal("ambiguous call was retried")
			}
		})
	}
}
func TestNoPATHFallbackOrInvalidHandleMutation(t *testing.T) {
	c, file := helper(t, "")
	c.Node = "node"
	if _, err := c.Attach(context.Background(), testHost(), 49199); err == nil {
		t.Fatal("PATH lookup permitted")
	}
	if err := c.Detach(context.Background(), Handle{LeaseID: "../active"}); err == nil {
		t.Fatal("invalid lease id accepted")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("invalid request launched a process")
	}
}
func TestKeepAliveCancellationOnlyDetaches(t *testing.T) {
	c, file := helper(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.KeepAlive(ctx, testLease().Handle(), 49199); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(file)
	var call struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(body, &call) != nil || call.Command != "detach" {
		t.Fatalf("unexpected cleanup: %s", body)
	}
}

func TestEndpointDiscoveryAndColdCAS(t *testing.T) {
	c, file := helper(t, "")
	ctx := context.Background()
	endpoint, err := c.ResolveEndpoint(ctx, 17306)
	if err != nil || endpoint.Port != 49199 || endpoint.Revision != 3 {
		t.Fatal(endpoint, err)
	}
	if _, err = c.ConfigureEndpoint(ctx, endpoint, 49200, false); err == nil {
		t.Fatal("confirmation bypass")
	}
	changed, err := c.ConfigureEndpoint(ctx, endpoint, 49200, true)
	if err != nil || changed.Revision != 4 {
		t.Fatal(changed, err)
	}
	body, _ := os.ReadFile(file)
	if len(strings.Split(strings.TrimSpace(string(body)), "\n")) != 2 {
		t.Fatal("implicit extra operation", string(body))
	}
	if !strings.Contains(string(body), `"expectedRevision":3`) || !strings.Contains(string(body), `"expectedPort":49199`) {
		t.Fatal("missing CAS", string(body))
	}
	bad, _ := helper(t, "bad-endpoint")
	if _, err = bad.ResolveEndpoint(ctx, 17306); err == nil {
		t.Fatal("accepted foreign endpoint")
	}
}
func TestConfirmedMaintenanceReusesStrictAttachmentValidation(t *testing.T) {
	ctx := context.Background()
	c, file := helper(t, "")
	prior, err := c.Attach(ctx, testHost(), 49199)
	if err != nil {
		t.Fatal(err)
	}
	revision := 7
	id := "44444444-4444-4444-8444-444444444444"
	if _, err = c.Maintain(ctx, testHost(), prior, 49199, "restart", id, false, &revision); err == nil {
		t.Fatal("confirmation bypass")
	}
	result, err := c.Maintain(ctx, testHost(), prior, 49199, "restart", id, true, &revision)
	if err != nil || result.Attachment.Receipt.DaemonID != "replacement" {
		t.Fatal(result, err)
	}
	body, _ := os.ReadFile(file)
	if !strings.Contains(string(body), `"settingsRevision":7`) {
		t.Fatal("unbound settings revision")
	}
	for _, mode := range []string{"wrong-replacement", "missing-attachment", "stale-replacement", "wrong-request"} {
		t.Run(mode, func(t *testing.T) {
			bad, _ := helper(t, mode)
			a, e := bad.Attach(ctx, testHost(), 49199)
			if e != nil {
				t.Fatal(e)
			}
			_, e = bad.Maintain(ctx, testHost(), a, 49199, "restart", id, true, &revision)
			var unknown *UnknownOutcome
			if !errors.As(e, &unknown) {
				t.Fatal("replacement accepted", e)
			}
		})
	}
}
func TestMaintenanceInspectionRecoveryNeverStarts(t *testing.T) {
	c, file := helper(t, "")
	ctx := context.Background()
	id := "44444444-4444-4444-8444-444444444444"
	if list, err := c.InspectMaintenances(ctx); err != nil || len(list) != 0 {
		t.Fatal(list, err)
	}
	if err := c.ReconcileMaintenance(ctx, id, "new-fingerprint", false); err == nil {
		t.Fatal("confirmation bypass")
	}
	if err := c.ReconcileMaintenance(ctx, id, "new-fingerprint", true); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(file)
	if strings.Contains(string(body), "attach-or-start") || strings.Contains(string(body), "ensure-core") || !strings.Contains(string(body), `"currentFingerprint":"new-fingerprint"`) {
		t.Fatal(string(body))
	}
}

func TestMaintenanceAttachmentIsExistingOnly(t *testing.T) {
	c, file := helper(t, "")
	ctx := context.Background()
	if a, err := c.AttachExisting(ctx, testHost(), 49199, "fingerprint"); err != nil || a.Spawned {
		t.Fatal(a, err)
	}
	if _, err := c.AttachExisting(ctx, testHost(), 49199, "different"); err == nil {
		t.Fatal("accepted different incarnation")
	}
	body, _ := os.ReadFile(file)
	if !strings.Contains(string(body), `"existingFingerprint":"fingerprint"`) {
		t.Fatal("missing atomic existing-only guard")
	}
}

// A running record gained an optional OS-boot stamp on the TypeScript side. The
// Go decoder rejects unknown fields, so every new record field must be mirrored
// here: without it, --stop, --restart and --repair-start all fail on a record
// written by the current Manager ("invalid start state").
func TestInspectStartAcceptsCurrentAndLegacyRecords(t *testing.T) {
	c, _ := helper(t, "")
	ctx := context.Background()
	state, err := c.InspectStart(ctx)
	if err != nil {
		t.Fatalf("a current record must decode: %v", err)
	}
	if state == nil || state.BootID != "boot-generation-1" || state.PID != 4321 {
		t.Fatalf("boot stamp was dropped: %#v", state)
	}
	legacyClient, _ := helper(t, "legacy-start-record")
	legacy, err := legacyClient.InspectStart(ctx)
	if err != nil {
		t.Fatalf("a record without a boot stamp must still decode: %v", err)
	}
	if legacy == nil || legacy.BootID != "" {
		t.Fatalf("legacy record must be accepted without a boot stamp: %#v", legacy)
	}
}

// The record written by a real Manager must decode in Go. The decoder rejects
// unknown fields, so the two schemas have to stay in step: adding a field on the
// TypeScript side without mirroring it here silently breaks --stop, --restart
// and --repair-start with "invalid start state".
func TestRunningRecordSchemaMatchesGoDecoder(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contracts", "src", "manager-protocol.ts"))
	if err != nil {
		t.Skip("contracts source is not present beside this module")
	}
	source := string(body)
	start := strings.Index(source, "export const RunningCoreRecordSchema")
	if start < 0 {
		t.Fatal("RunningCoreRecordSchema not found")
	}
	end := strings.Index(source[start:], ".strict()")
	if end < 0 {
		t.Fatal("RunningCoreRecordSchema terminator not found")
	}
	fieldName := regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]*):`)
	declared := map[string]bool{}
	for _, line := range strings.Split(source[start:start+end], "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "export const") {
			continue
		}
		if m := fieldName.FindStringSubmatch(trimmed); m != nil {
			declared[m[1]] = true
		}
	}
	if len(declared) == 0 {
		t.Fatal("no fields parsed from RunningCoreRecordSchema")
	}
	// Read the real Go surface instead of restating the field list, so this test
	// fails when either side changes without the other.
	handled := map[string]bool{}
	typ := reflect.TypeOf(StartState{})
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		handled[strings.Split(tag, ",")[0]] = true
	}
	for field := range declared {
		if !handled[field] {
			t.Fatalf("RunningCoreRecordSchema field %q is not handled by the Go StartState decoder; add it or every start/stop/repair command breaks", field)
		}
	}
}
