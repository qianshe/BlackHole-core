package coremanager

import (
	"context"
	"encoding/json"
	"errors"
)

type StartState struct {
	SchemaVersion    int      `json:"schemaVersion"`
	Status           string   `json:"status"`
	PID              int      `json:"pid,omitempty"`
	VersionName      string   `json:"versionName"`
	DescriptorHash   string   `json:"descriptorHash"`
	DataRootID       string   `json:"dataRootId"`
	DBPath           string   `json:"dbPath"`
	Port             int      `json:"port"`
	StartFingerprint string   `json:"startFingerprint"`
	Receipt          *Receipt `json:"receipt,omitempty"`
	// Operating-system boot that wrote this record. Absent on records written
	// before the field existed; the Manager decides what that proves. The Go
	// decoders reject unknown fields, so every new record field must be added
	// here as well as in the TypeScript schema.
	BootID string `json:"bootId,omitempty"`
}

func (c Client) Ensure(ctx context.Context, host Host, port int, seed, seedHash string) error {
	if host.Capabilities == nil {
		host.Capabilities = []string{}
	}
	var out struct {
		VersionName string `json:"versionName"`
		Reused      bool   `json:"reused"`
	}
	err := c.invoke(ctx, map[string]any{"command": "ensure-core", "request": map[string]any{"client": host, "port": port, "seedArchive": seed, "seedArchiveHash": seedHash}}, &out)
	if err != nil {
		return err
	}
	if out.VersionName == "" {
		return &UnknownOutcome{Reason: "empty selection"}
	}
	return nil
}
func (c Client) InspectStart(ctx context.Context) (*StartState, error) {
	var raw json.RawMessage
	if err := c.invoke(ctx, map[string]any{"command": "inspect-start"}, &raw); err != nil {
		return nil, err
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var state StartState
	if decode(raw, &state) != nil || state.SchemaVersion != 1 || !hashPattern.MatchString(state.DataRootID) || !hashPattern.MatchString(state.DescriptorHash) || state.StartFingerprint == "" {
		return nil, &UnknownOutcome{Reason: "invalid start state"}
	}
	return &state, nil
}
// RecoverStart archives a stale start record. Evidence that the recorded
// incarnation cannot be running (exited process, an earlier OS boot, or an
// expired Core heartbeat lease) is proven by the Manager. force additionally
// accepts a record whose port is positively closed and whose client leases have
// all expired; it is an operator decision and never kills or stops anything.
func (c Client) RecoverStart(ctx context.Context, state StartState, confirmed bool, force ...bool) error {
	if !confirmed {
		return errors.New("recovery_confirmation_required")
	}
	var out struct {
		Recovered bool `json:"recovered"`
	}
	request := map[string]any{"confirmed": true, "dataRootId": state.DataRootID, "descriptorHash": state.DescriptorHash, "startFingerprint": state.StartFingerprint}
	if len(force) > 0 && force[0] {
		request["force"] = true
	}
	return c.invoke(ctx, map[string]any{"command": "recover-start", "request": request}, &out)
}
func (c Client) OpenBrowser(ctx context.Context, handle Handle, port int) error {
	var out struct {
		Opened bool `json:"opened"`
	}
	if err := c.invoke(ctx, map[string]any{"command": "open-browser", "request": map[string]any{"handle": handle, "port": port}}, &out); err != nil {
		return err
	}
	if !out.Opened {
		return errors.New("browser_unavailable")
	}
	return nil
}
