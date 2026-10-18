package platform

import (
	"strings"
	"testing"
	"time"
)

func TestLoadConfigValidatesComponentSpecificValues(t *testing.T) {
	lookup := envLookup(map[string]string{
		"LOOMHELM_VERSION":          "test-version",
		"LOOMHELM_HTTP_ADDR":        "127.0.0.1:0",
		"LOOMHELM_DRAIN_TOKEN":      "test-token",
		"LOOMHELM_SHUTDOWN_TIMEOUT": "250ms",
		"LOOMHELM_DATABASE_URL":     "postgres://test@localhost/loomhelm",
	})

	config, err := LoadConfigWithLookup(ComponentServer, lookup)
	if err != nil {
		t.Fatalf("LoadConfigWithLookup() error = %v", err)
	}
	if config.Version != "test-version" || config.HTTPAddr != "127.0.0.1:0" || config.DrainToken != "test-token" || config.ShutdownTimeout != 250*time.Millisecond {
		t.Fatalf("unexpected config: %+v", config)
	}
}

func TestDatabaseConfigurationBoundaries(t *testing.T) {
	for _, component := range []Component{ComponentServer, ComponentWorker} {
		t.Run(string(component), func(t *testing.T) {
			base := map[string]string{"LOOMHELM_DRAIN_TOKEN": "test-token"}
			if _, err := LoadConfigWithLookup(component, envLookup(base)); err == nil || !strings.Contains(err.Error(), "LOOMHELM_DATABASE_URL") {
				t.Fatalf("missing database URL error = %v", err)
			}
			base["LOOMHELM_DATABASE_URL"] = "postgres://test@localhost/loomhelm"
			cfg, err := LoadConfigWithLookup(component, envLookup(base))
			if err != nil || cfg.DatabaseMaxConns != 4 || cfg.DatabaseMinConns != 0 || cfg.StartupBudget() != 30*time.Second {
				t.Fatalf("default database configuration error = %v", err)
			}
			for _, test := range []struct{ key, value, want string }{
				{"LOOMHELM_DATABASE_URL", "postgres://user:secret-dsn@localhost:invalid/db", "invalid LOOMHELM_DATABASE_URL"},
				{"LOOMHELM_DATABASE_MIN_CONNS", "-1", "LOOMHELM_DATABASE_MIN_CONNS"},
				{"LOOMHELM_DATABASE_MAX_CONNS", "2147483648", "LOOMHELM_DATABASE_MAX_CONNS"},
				{"LOOMHELM_DATABASE_MIN_CONNS", "5", "minimum connections"},
				{"LOOMHELM_STARTUP_TIMEOUT", "0s", "LOOMHELM_STARTUP_TIMEOUT"},
			} {
				original, exists := base[test.key]
				base[test.key] = test.value
				_, err := LoadConfigWithLookup(component, envLookup(base))
				if err == nil || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "secret-dsn") {
					t.Fatalf("%s error = %v", test.key, err)
				}
				if exists {
					base[test.key] = original
				} else {
					delete(base, test.key)
				}
			}
		})
	}
	connector, err := LoadConfigWithLookup(ComponentConnector, envLookup(map[string]string{
		"LOOMHELM_CONNECTOR_SERVER_URL": "https://platform.example.test",
		"LOOMHELM_DATABASE_URL":         "invalid", "LOOMHELM_DATABASE_MAX_CONNS": "invalid",
		"LOOMHELM_STARTUP_TIMEOUT": "invalid",
	}))
	if err != nil || connector.DatabaseURL != "" {
		t.Fatalf("connector consumed database configuration: %v", err)
	}
}

func TestLoadConfigRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name      string
		component Component
		env       map[string]string
		wantError string
	}{
		{
			name:      "unknown component",
			component: Component("scheduler"),
			wantError: "unknown component",
		},
		{
			name:      "invalid HTTP address",
			component: ComponentServer,
			env:       map[string]string{"LOOMHELM_HTTP_ADDR": "localhost"},
			wantError: "LOOMHELM_HTTP_ADDR",
		},
		{
			name:      "HTTP address host whitespace",
			component: ComponentServer,
			env:       map[string]string{"LOOMHELM_HTTP_ADDR": " :8080"},
			wantError: "LOOMHELM_HTTP_ADDR",
		},
		{
			name:      "drain token whitespace",
			component: ComponentServer,
			env:       map[string]string{"LOOMHELM_DRAIN_TOKEN": "test token"},
			wantError: "drain token",
		},
		{
			name:      "missing drain token",
			component: ComponentServer,
			env:       map[string]string{"LOOMHELM_HTTP_ADDR": "127.0.0.1:8080"},
			wantError: "drain token",
		},
		{
			name:      "invalid timeout",
			component: ComponentWorker,
			env:       map[string]string{"LOOMHELM_SHUTDOWN_TIMEOUT": "0s"},
			wantError: "LOOMHELM_SHUTDOWN_TIMEOUT",
		},
		{
			name:      "invalid worker generation",
			component: ComponentWorker,
			env:       map[string]string{"LOOMHELM_WORKER_GENERATION": "0"},
			wantError: "LOOMHELM_WORKER_GENERATION",
		},
		{
			name:      "invalid connector URL",
			component: ComponentConnector,
			env:       map[string]string{"LOOMHELM_CONNECTOR_SERVER_URL": "ftp://example.test"},
			wantError: "LOOMHELM_CONNECTOR_SERVER_URL",
		},
		{
			name:      "missing connector URL",
			component: ComponentConnector,
			wantError: "LOOMHELM_CONNECTOR_SERVER_URL",
		},
		{
			name:      "connector URL with credentials",
			component: ComponentConnector,
			env:       map[string]string{"LOOMHELM_CONNECTOR_SERVER_URL": "https://user:pass@example.test"},
			wantError: "LOOMHELM_CONNECTOR_SERVER_URL",
		},
		{
			name:      "connector URL with invalid port",
			component: ComponentConnector,
			env:       map[string]string{"LOOMHELM_CONNECTOR_SERVER_URL": "https://platform.example.test:65536"},
			wantError: "LOOMHELM_CONNECTOR_SERVER_URL",
		},
		{
			name:      "connector URL with non-numeric port",
			component: ComponentConnector,
			env:       map[string]string{"LOOMHELM_CONNECTOR_SERVER_URL": "https://platform.example.test:bad"},
			wantError: "LOOMHELM_CONNECTOR_SERVER_URL",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := LoadConfigWithLookup(test.component, envLookup(test.env))
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("LoadConfigWithLookup() error = %v, want substring %q", err, test.wantError)
			}
		})
	}
}

func envLookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
