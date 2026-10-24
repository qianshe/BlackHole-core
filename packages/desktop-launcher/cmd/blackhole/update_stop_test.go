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
func TestUpdateStopCancellationAndActivityNeverAuthorizeInstaller(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		f := &fakeMaintenanceManager{start: testStart()}
		p := &fakePrompts{confirm: refuse}
		if refuse {
			f.maintainErr = errors.New("active_work")
		}
		c, _ := testCoordinator(f, p, maintenanceHooks{})
		if c.StopForUpdate(context.Background()) {
			t.Fatal("unconfirmed/busy stop allowed")
		}
		if !refuse && f.maintainCalls != 0 {
			t.Fatal("cancelled request sent")
		}
	}
}
