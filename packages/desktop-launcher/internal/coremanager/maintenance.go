package coremanager

import (
	"context"
	"errors"
)

type Endpoint struct {
	SchemaVersion int    `json:"schemaVersion"`
	DataRootID    string `json:"dataRootId"`
	Port          int    `json:"port"`
	Revision      int    `json:"revision"`
}

func (c Client) ResolveEndpoint(ctx context.Context, fallback int) (Endpoint, error) {
	var out Endpoint
	if fallback < 1 || fallback > 65535 {
		return out, errors.New("port_invalid")
	}
	if err := c.invoke(ctx, map[string]any{"command": "resolve-endpoint", "request": map[string]any{"fallbackPort": fallback}}, &out); err != nil {
		return out, err
	}
	if out.SchemaVersion != 1 || !hashPattern.MatchString(out.DataRootID) || out.Port < 1 || out.Port > 65535 || out.Revision < 0 {
		return Endpoint{}, &UnknownOutcome{Reason: "endpoint_invalid"}
	}
	return out, nil
}
func (c Client) ConfigureEndpoint(ctx context.Context, expected Endpoint, port int, confirmed bool) (Endpoint, error) {
	var out Endpoint
	if !confirmed || port < 1 || port > 65535 {
		return out, errors.New("endpoint_confirmation_required")
	}
	if err := c.invoke(ctx, map[string]any{"command": "configure-endpoint", "request": map[string]any{"confirmed": true, "expectedPort": expected.Port, "expectedRevision": expected.Revision, "port": port}}, &out); err != nil {
		return out, err
	}
	revision := expected.Revision
	if port != expected.Port {
		revision++
	}
	if out.SchemaVersion != 1 || out.DataRootID != expected.DataRootID || out.Port != port || out.Revision != revision {
		return Endpoint{}, &UnknownOutcome{Reason: "endpoint_mismatch"}
	}
	return out, nil
}

type MaintenanceRecord struct {
	SchemaVersion int        `json:"schemaVersion"`
	RequestID     string     `json:"requestId"`
	Operation     string     `json:"operation"`
	RequestHash   string     `json:"requestHash"`
	Target        StartState `json:"target"`
	State         string     `json:"state"`
	UpdatedAt     string     `json:"updatedAt"`
}

func (c Client) InspectMaintenances(ctx context.Context) ([]MaintenanceRecord, error) {
	var out []MaintenanceRecord
	if err := c.invoke(ctx, map[string]any{"command": "inspect-maintenances"}, &out); err != nil {
		return nil, err
	}
	if out == nil {
		return nil, &UnknownOutcome{Reason: "maintenance_records_invalid"}
	}
	for _, r := range out {
		if r.SchemaVersion != 1 || !uuidPattern.MatchString(r.RequestID) || !hashPattern.MatchString(r.RequestHash) || !hashPattern.MatchString(r.Target.DataRootID) || !hashPattern.MatchString(r.Target.DescriptorHash) {
			return nil, &UnknownOutcome{Reason: "maintenance_record_invalid"}
		}
	}
	return out, nil
}
func (c Client) RecoverMaintenance(ctx context.Context, id string, confirmed bool) error {
	return c.ReconcileMaintenance(ctx, id, "", confirmed)
}
func (c Client) ReconcileMaintenance(ctx context.Context, id, fingerprint string, confirmed bool) error {
	if !confirmed || !uuidPattern.MatchString(id) || len(fingerprint) > 500 {
		return errors.New("maintenance_confirmation_required")
	}
	var out struct {
		Observed  string `json:"observed,omitempty"`
		Recovered bool   `json:"recovered"`
		Restarted bool   `json:"restarted"`
		RequestID string `json:"requestId"`
	}
	request := map[string]any{"confirmed": true, "requestId": id}
	if fingerprint != "" {
		request["currentFingerprint"] = fingerprint
	}
	if err := c.invoke(ctx, map[string]any{"command": "recover-maintenance", "request": request}, &out); err != nil {
		return err
	}
	if !out.Recovered || out.Restarted || out.RequestID != id || (fingerprint != "" && out.Observed != "running") || (fingerprint == "" && out.Observed != "") {
		return &UnknownOutcome{Reason: "maintenance_recovery_invalid"}
	}
	return nil
}

type MaintenanceResult struct {
	Operation  string      `json:"operation"`
	Stopped    bool        `json:"stopped"`
	RequestID  string      `json:"requestId"`
	Attachment *Attachment `json:"attachment,omitempty"`
}

func (c Client) Maintain(ctx context.Context, host Host, prior Attachment, port int, operation, id string, confirmed bool, revision *int) (MaintenanceResult, error) {
	var out MaintenanceResult
	if !confirmed || !uuidPattern.MatchString(id) || !validHandle(prior.Lease.Handle()) || (operation != "stop" && operation != "restart") || (revision != nil && (*revision < 0 || operation != "restart")) {
		return out, errors.New("maintenance_request_invalid")
	}
	if err := validateAttachment(prior, host, port); err != nil {
		return out, err
	}
	if host.Capabilities == nil {
		host.Capabilities = []string{}
	}
	request := map[string]any{"confirmed": true, "requestId": id, "operation": operation, "client": host, "handle": prior.Lease.Handle(), "port": port}
	if revision != nil {
		request["settingsRevision"] = *revision
	}
	if err := c.invoke(ctx, map[string]any{"command": "maintain-core", "request": request}, &out); err != nil {
		return out, err
	}
	if out.RequestID != id || out.Operation != operation || !out.Stopped {
		return MaintenanceResult{}, &UnknownOutcome{Reason: "maintenance_result_invalid"}
	}
	if operation == "restart" {
		if out.Attachment == nil {
			return MaintenanceResult{}, &UnknownOutcome{Reason: "replacement_missing"}
		}
		if err := validateAttachment(*out.Attachment, host, port); err != nil {
			return MaintenanceResult{}, err
		}
		r := out.Attachment.Receipt
		if r.DaemonID == prior.Receipt.DaemonID || r.StartFingerprint == prior.Receipt.StartFingerprint || r.DescriptorHash != prior.Receipt.DescriptorHash || r.DataRootID != prior.Receipt.DataRootID || r.RuntimeID != prior.Receipt.RuntimeID || r.BuildID != prior.Receipt.BuildID || out.Attachment.Lease.LeaseID == prior.Lease.LeaseID {
			return MaintenanceResult{}, &UnknownOutcome{Reason: "replacement_target_mismatch"}
		}
	} else if out.Attachment != nil {
		return MaintenanceResult{}, &UnknownOutcome{Reason: "unexpected_replacement"}
	}
	return out, nil
}
