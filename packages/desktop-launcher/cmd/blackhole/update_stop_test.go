package main

import (
	"blackhole/desktop-launcher/internal/coremanager"
	"context"
	"errors"
	"testing"
)

func TestUpdateStopRetainsTrayUntilHelperHandoff(t *testing.T) {
	f := &fakeMaintenanceManager{start: testStart(), result: coremanager.MaintenanceResult{Operation: "stop", Stopped: true, RequestID: "33333333-3333-4333-8333-333333333333"}}
	p := &fakePrompts{confirm: true}
	quit := false
	c, k := testCoordinator(f, p, maintenanceHooks{OnStopped: func() { quit = true }})
	if !c.StopForUpdate(context.Background()) || quit || f.maintainCalls != 1 {
		t.Fatal("update stopped/quit ordering", quit, f.maintainCalls)
	}
	k.release()
	if f.detaches != 0 {
		t.Fatal("consumed lease detached again")
	}
}
func TestUpdateStopIsClickAuthorizedAndRefusedOnActivity(t *testing.T) {
	// The settings-card download click is the authorization: no confirmation
	// dialog may block the update stop, so even a refusing prompt proceeds.
	f := &fakeMaintenanceManager{start: testStart()}
	p := &fakePrompts{confirm: false}
	c, k := testCoordinator(f, p, maintenanceHooks{})
	if !c.StopForUpdate(context.Background()) || f.maintainCalls != 1 {
		t.Fatal("update stop blocked by a confirmation prompt", f.maintainCalls)
	}
	k.release()
	// A Manager refusal (active work/clients) still denies the installer path.
	f2 := &fakeMaintenanceManager{start: testStart()}
	f2.maintainErr = errors.New("active_work")
	c2, _ := testCoordinator(f2, &fakePrompts{confirm: true}, maintenanceHooks{})
	if c2.StopForUpdate(context.Background()) {
		t.Fatal("busy stop allowed")
	}
}
