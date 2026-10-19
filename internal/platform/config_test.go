package platform

import (
	"math"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDatabaseOnlyConfigurationMatchesProcesses(t *testing.T) {
	for _, test := range []struct {
		name      string
		env       map[string]string
		min, max  int32
		wantError string
	}{
		{name: "defaults", min: 0, max: 4},
		{name: "explicit pool", env: map[string]string{"LOOMHELM_DATABASE_MIN_CONNS": "1", "LOOMHELM_DATABASE_MAX_CONNS": "2"}, min: 1, max: 2},
		{name: "inherit pool maximum", env: map[string]string{"LOOMHELM_DATABASE_MAX_CONNS": "0"}, min: 0, max: 0},
		{name: "keyword DSN", env: map[string]string{"LOOMHELM_DATABASE_URL": "host=127.0.0.1 port=55441 dbname=loomhelm user=test"}, min: 0, max: 4},
		{name: "missing URL", env: map[string]string{"LOOMHELM_DATABASE_URL": "", "LOOMHELM_POSTGRES_PORT": ""}, wantError: "LOOMHELM_DATABASE_URL"},
		{name: "mismatched target", env: map[string]string{"LOOMHELM_POSTGRES_PORT": "55442"}, wantError: "port must match"},
		{name: "negative minimum", env: map[string]string{"LOOMHELM_DATABASE_MIN_CONNS": "-1"}, wantError: "LOOMHELM_DATABASE_MIN_CONNS"},
		{name: "non-numeric maximum", env: map[string]string{"LOOMHELM_DATABASE_MAX_CONNS": "invalid"}, wantError: "LOOMHELM_DATABASE_MAX_CONNS"},
		{name: "maximum overflow", env: map[string]string{"LOOMHELM_DATABASE_MAX_CONNS": "2147483648"}, wantError: "LOOMHELM_DATABASE_MAX_CONNS"},
		{name: "minimum exceeds maximum", env: map[string]string{"LOOMHELM_DATABASE_MIN_CONNS": "5"}, wantError: "minimum connections"},
		{name: "redacted parse error", env: map[string]string{"LOOMHELM_DATABASE_URL": "postgres://user:secret-dsn@localhost:invalid/db"}, wantError: "invalid LOOMHELM_DATABASE_URL"},
	} {
		t.Run(test.name, func(t *testing.T) {
			env := map[string]string{
				"LOOMHELM_DATABASE_URL":  "postgres://test@127.0.0.1:55441/loomhelm",
				"LOOMHELM_POSTGRES_PORT": "55441",
				"LOOMHELM_DRAIN_TOKEN":   "test-token",
			}
			for key, value := range test.env {
				env[key] = value
			}
			database, err := LoadDatabaseConfigWithLookup(envLookup(env))
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) || strings.Contains(err.Error(), "secret-dsn") {
					t.Fatalf("database-only configuration error = %v, want %q without credentials", err, test.wantError)
				}
			} else if err != nil || database.MinConns != test.min || database.MaxConns != test.max {
				t.Fatalf("database-only limits = (%d, %d), error = %v", database.MinConns, database.MaxConns, err)
			}
			for _, component := range []Component{ComponentServer, ComponentWorker} {
				process, processErr := LoadConfigWithLookup(component, envLookup(env))
				if test.wantError != "" {
					if processErr == nil || !strings.Contains(processErr.Error(), test.wantError) || strings.Contains(processErr.Error(), "secret-dsn") {
						t.Fatalf("%s database configuration error = %v", component, processErr)
					}
				} else if processErr != nil || process.DatabaseURL != database.URL || process.DatabaseMinConns != database.MinConns || process.DatabaseMaxConns != database.MaxConns {
					t.Fatalf("%s database configuration differs from database-only configuration: %v", component, processErr)
				}
			}
		})
	}
}

func TestDatabaseOnlyConfigurationIgnoresUnrelatedProcessSettings(t *testing.T) {
	_, err := LoadDatabaseConfigWithLookup(envLookup(map[string]string{
		"LOOMHELM_DATABASE_URL":      "postgres://test@localhost/loomhelm",
		"LOOMHELM_VERSION":           "",
		"LOOMHELM_HTTP_ADDR":         "invalid",
		"LOOMHELM_DRAIN_TOKEN":       "",
		"LOOMHELM_WORKER_GENERATION": "0",
		"LOOMHELM_STARTUP_TIMEOUT":   "invalid",
		"LOOMHELM_SHUTDOWN_TIMEOUT":  "invalid",
	}))
	if err != nil {
		t.Fatalf("database-only configuration consumed unrelated process settings: %v", err)
	}
	if _, err := LoadDatabaseConfigWithLookup(nil); err == nil {
		t.Fatal("nil configuration lookup was accepted")
	}
}

func TestWorkerGenerationMatchesDurableSignedRange(t *testing.T) {
	for _, value := range []uint64{1, math.MaxInt64, math.MaxInt64 + 1, math.MaxUint64} {
		env := map[string]string{
			"LOOMHELM_DATABASE_URL":      "postgres://test@localhost/loomhelm",
			"LOOMHELM_WORKER_GENERATION": strconv.FormatUint(value, 10),
		}
		_, err := LoadConfigWithLookup(ComponentWorker, envLookup(env))
		if (err == nil) != (value <= math.MaxInt64) {
			t.Fatalf("generation=%d: LoadConfig error = %v", value, err)
		}
		cfg := Config{Component: ComponentWorker, Version: "test", ShutdownTimeout: time.Second, DatabaseURL: env["LOOMHELM_DATABASE_URL"], WorkerGeneration: value}
		if err := cfg.Validate(); (err == nil) != (value <= math.MaxInt64) {
			t.Fatalf("generation=%d: Validate error = %v", value, err)
		}
	}
}

func TestDevelopmentDatabasePortMustMatchBeforeConnection(t *testing.T) {
	for _, test := range []struct {
		name, url, port string
		valid           bool
	}{
		{"deployment without Compose", "postgres://test@db.example.test:5433/loomhelm", "", true},
		{"matched URL", "postgres://test@127.0.0.1:55441/loomhelm", "55441", true},
		{"matched keyword DSN", "host=127.0.0.1 port=55442 dbname=loomhelm user=test", "55442", true},
		{"stale copied URL", "postgres://test@127.0.0.1:55432/loomhelm", "55441", false},
		{"zero port", "postgres://test@127.0.0.1/loomhelm", "0", false},
		{"port out of range", "postgres://test@127.0.0.1/loomhelm", "65536", false},
		{"invalid port", "postgres://test@127.0.0.1/loomhelm", "other", false},
		{"invalid URL with secret", "postgres://user:secret-dsn@localhost:invalid/db", "55441", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := ValidateDevelopmentDatabaseTarget(test.url, test.port); (err == nil) != test.valid || (err != nil && strings.Contains(err.Error(), "secret-dsn")) {
				t.Fatalf("ValidateDevelopmentDatabaseTarget error = %v", err)
			}
			for _, component := range []Component{ComponentServer, ComponentWorker} {
				_, err := LoadConfigWithLookup(component, envLookup(map[string]string{
					"LOOMHELM_DATABASE_URL": test.url, "LOOMHELM_POSTGRES_PORT": test.port, "LOOMHELM_DRAIN_TOKEN": "token",
				}))
				if (err == nil) != test.valid {
					t.Fatalf("%s LoadConfig error = %v", component, err)
				}
			}
		})
	}
}

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
		"LOOMHELM_POSTGRES_PORT":   "invalid",
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
