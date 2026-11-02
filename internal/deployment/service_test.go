package deployment

import "testing"

func TestCapabilitiesForRoleMatchesInstallationPermissionMatrix(t *testing.T) {
	tests := []struct {
		name         string
		role         Role
		capabilities []Capability
	}{
		{name: "observer", role: RoleObserver, capabilities: []Capability{CapabilityView}},
		{name: "operator", role: RoleOperator, capabilities: []Capability{CapabilityView, CapabilityPreflight, CapabilityStage}},
		{name: "releaser", role: RoleReleaser, capabilities: []Capability{CapabilityView, CapabilityPreflight, CapabilityStage, CapabilityPromote, CapabilityRollback}},
		{name: "recovery", role: RoleRecovery, capabilities: []Capability{CapabilityView, CapabilityReconcile, CapabilityDrain}},
		{name: "owner", role: RoleOwner, capabilities: []Capability{CapabilityView, CapabilityPreflight, CapabilityStage, CapabilityPromote, CapabilityRollback, CapabilityReconcile, CapabilityDrain}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := capabilitiesForRole(test.role)
			if len(got) != len(test.capabilities) {
				t.Fatalf("capabilities = %v, want %v", got, test.capabilities)
			}
			for index, capability := range test.capabilities {
				if got[index] != capability {
					t.Fatalf("capabilities = %v, want %v", got, test.capabilities)
				}
			}
		})
	}
}

func TestProjectRolesDoNotGrantDeploymentCapabilities(t *testing.T) {
	for _, role := range []Role{"viewer", "operator", "owner", "project_viewer", "project_operator", "project_owner"} {
		for _, capability := range []Capability{CapabilityView, CapabilityPreflight, CapabilityStage, CapabilityPromote, CapabilityRollback, CapabilityReconcile, CapabilityDrain} {
			if allowed(role, capability) {
				t.Fatalf("project role %q unexpectedly grants %q", role, capability)
			}
		}
	}
}
