package codex

import "testing"

func TestRecoverySnapshotAllowedAfterOnlineHostRestart(t *testing.T) {
	tests := []struct {
		name       string
		recovery   bool
		hostStatus string
		syncState  string
		want       bool
	}{
		{name: "verified recovery replaces completed state", recovery: true, hostStatus: "online", syncState: "complete", want: true},
		{name: "verified recovery replaces stale state", recovery: true, hostStatus: "online", syncState: "stale", want: true},
		{name: "active sync remains fenced", recovery: true, hostStatus: "online", syncState: "syncing", want: false},
		{name: "non recovery snapshot remains fenced", recovery: false, hostStatus: "online", syncState: "complete", want: false},
		{name: "offline Host remains fenced", recovery: true, hostStatus: "offline", syncState: "complete", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := recoverySnapshotAllowed(test.recovery, test.hostStatus, test.syncState); got != test.want {
				t.Fatalf("recoverySnapshotAllowed() = %t, want %t", got, test.want)
			}
		})
	}
}
