package coremanager

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestBundledStartIsOneAutomaticVerifiedStartup(t *testing.T) {
	c, file := helper(t, "")
	target := StagedCore{VersionName: "0.4.7-signed", RuntimeVersion: "0.4.7", DescriptorHash: testHash}
	result, err := c.StartStagedBundle(context.Background(), testHost(), 49199, target, testUUID)
	if err != nil || result.State != "updated" || result.Attachment.Receipt.RuntimeVersion != "0.4.7" {
		t.Fatal(result, err)
	}
	body, _ := os.ReadFile(file)
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	if len(lines) != 1 {
		t.Fatal("startup unexpectedly called a second manager operation", string(body))
	}
	var request struct {
		Command string
		Request map[string]any
	}
	if json.Unmarshal([]byte(lines[0]), &request) != nil || request.Command != "start-bundled-core" {
		t.Fatal(string(body))
	}
	if request.Request["reconnectAfterUpgrade"] != true || request.Request["descriptorHash"] != testHash {
		t.Fatal(request)
	}
	if _, ok := request.Request["confirmed"]; ok {
		t.Fatal("normal startup must not require a separate UI approval")
	}
}
func TestBundledStartNeverClaimsStagedVersionAsRunning(t *testing.T) {
	target := StagedCore{VersionName: "0.4.7-signed", RuntimeVersion: "0.4.7", DescriptorHash: testHash}
	c, _ := helper(t, "bundle-deferred")
	result, err := c.StartStagedBundle(context.Background(), testHost(), 49199, target, testUUID)
	if err != nil || result.State != "deferred" || result.Reason != "active_work" || result.Attachment.Receipt.RuntimeVersion != "0.4.6" {
		t.Fatal(result, err)
	}
	c, _ = helper(t, "bundle-lie")
	_, err = c.StartStagedBundle(context.Background(), testHost(), 49199, target, testUUID)
	var unknown *UnknownOutcome
	if !errors.As(err, &unknown) {
		t.Fatal("a false updated receipt was accepted", err)
	}
}
func TestPeerReconnectKeepsDataRootAndNeverSpawns(t *testing.T) {
	prior := Attachment{Receipt: testReceipt(), Lease: testLease()}
	c, file := helper(t, "")
	next, err := c.RestoreAttachment(context.Background(), testHost(), prior, 49199)
	if err != nil || next.Receipt.DaemonID == prior.Receipt.DaemonID || next.Spawned {
		t.Fatal(next, err)
	}
	body, _ := os.ReadFile(file)
	if strings.Count(string(body), "reconnect-core") != 1 || strings.Contains(string(body), "attach-or-start") {
		t.Fatal(string(body))
	}
	for _, mode := range []string{"reconnect-root", "reconnect-spawn", "malformed"} {
		c, _ = helper(t, mode)
		if _, err = c.RestoreAttachment(context.Background(), testHost(), prior, 49199); err == nil {
			t.Fatal("accepted unproven reattachment", mode)
		}
	}
}
