package platform

import "testing"

func TestDeploymentControllerConfigurationLoadsInstallationOwners(t *testing.T) {
	base := map[string]string{
		"LOOMHELM_DATABASE_URL":              "postgres://test@localhost/loomhelm",
		"LOOMHELM_DEPLOYMENT_HTTP_ADDR":      "127.0.0.1:8090",
		"LOOMHELM_DEPLOYMENT_OWNER_USER_IDS": "owner-a, owner-b",
		"LOOMHELM_SESSION_COOKIE_SECURE":     "true",
	}
	cfg, err := LoadConfigWithLookup(ComponentDeploymentController, envLookup(base))
	if err != nil {
		t.Fatalf("LoadConfigWithLookup() error = %v", err)
	}
	if cfg.DeploymentHTTPAddr != "127.0.0.1:8090" || len(cfg.DeploymentOwnerUserIDs) != 2 || cfg.DeploymentOwnerUserIDs[1] != "owner-b" {
		t.Fatalf("unexpected deployment controller config: %+v", cfg)
	}
}
