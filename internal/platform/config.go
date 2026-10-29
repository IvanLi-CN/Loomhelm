package platform

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Component string

const (
	ComponentServer    Component = "server"
	ComponentWorker    Component = "worker"
	ComponentConnector Component = "connector"
)

type Config struct {
	Component                 Component
	Version                   string
	CandidateSourceSHA        string
	ArtifactDigest            string
	HTTPAddr                  string
	WorkerHTTPAddr            string
	DrainToken                string
	ShutdownTimeout           time.Duration
	StartupTimeout            time.Duration
	DatabaseURL               string
	DatabaseMinConns          int32
	DatabaseMaxConns          int32
	WorkerGeneration          uint64
	WorkerLeaseKey            string
	ConnectorServerURL        string
	ConnectorHostID           string
	ConnectorToken            string
	ConnectorJournalPath      string
	ConnectorAppServerCommand string
	ConnectorWorkingDir       string
	BrowserAuth               BrowserAuthConfig
}

// DatabaseConfig is shared by processes and database-only tools so their
// environment parsing and development-target checks cannot drift apart.
type DatabaseConfig struct {
	URL      string
	MinConns int32
	MaxConns int32
}

func LoadDatabaseConfig() (DatabaseConfig, error) {
	return LoadDatabaseConfigWithLookup(os.LookupEnv)
}

func LoadDatabaseConfigWithLookup(lookup func(string) (string, bool)) (DatabaseConfig, error) {
	config, err := databaseConfigFromLookup(lookup)
	if err != nil {
		return DatabaseConfig{}, err
	}
	if err := config.Validate(); err != nil {
		return DatabaseConfig{}, err
	}
	return config, nil
}

func databaseConfigFromLookup(lookup func(string) (string, bool)) (DatabaseConfig, error) {
	if lookup == nil {
		return DatabaseConfig{}, fmt.Errorf("configuration lookup must not be nil")
	}
	config := DatabaseConfig{
		URL: strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_DATABASE_URL", "")),
	}
	if err := ValidateDevelopmentDatabaseTarget(config.URL, lookupOrDefault(lookup, "LOOMHELM_POSTGRES_PORT", "")); err != nil {
		return DatabaseConfig{}, err
	}
	var err error
	config.MinConns, err = poolSizeFromEnv(lookup, "LOOMHELM_DATABASE_MIN_CONNS", 0)
	if err != nil {
		return DatabaseConfig{}, err
	}
	config.MaxConns, err = poolSizeFromEnv(lookup, "LOOMHELM_DATABASE_MAX_CONNS", 4)
	if err != nil {
		return DatabaseConfig{}, err
	}
	return config, nil
}

func (c DatabaseConfig) Validate() error {
	if strings.TrimSpace(c.URL) == "" {
		return fmt.Errorf("LOOMHELM_DATABASE_URL must not be empty")
	}
	// Parse errors may contain credentials from the URL or keyword DSN.
	poolConfig, err := pgxpool.ParseConfig(c.URL)
	if err != nil {
		return fmt.Errorf("invalid LOOMHELM_DATABASE_URL")
	}
	if c.MinConns < 0 || c.MaxConns < 0 {
		return fmt.Errorf("database pool sizes must not be negative")
	}
	if c.MinConns > 0 {
		poolConfig.MinConns = c.MinConns
	}
	if c.MaxConns > 0 {
		poolConfig.MaxConns = c.MaxConns
	}
	if poolConfig.MinConns < 0 || poolConfig.MaxConns < 0 {
		return fmt.Errorf("database pool sizes must not be negative")
	}
	if poolConfig.MinConns > poolConfig.MaxConns {
		return fmt.Errorf("database minimum connections must not exceed maximum connections")
	}
	return nil
}

func LoadConfig(component Component) (Config, error) {
	return LoadConfigWithLookup(component, os.LookupEnv)
}

func LoadConfigWithLookup(component Component, lookup func(string) (string, bool)) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("configuration lookup must not be nil")
	}
	if !isKnownComponent(component) {
		return Config{}, fmt.Errorf("unknown component %q", component)
	}

	version := lookupOrDefault(lookup, "LOOMHELM_VERSION", "dev")
	if strings.TrimSpace(version) == "" {
		return Config{}, fmt.Errorf("LOOMHELM_VERSION must not be empty")
	}

	shutdownTimeout, err := durationFromEnv(lookup, "LOOMHELM_SHUTDOWN_TIMEOUT", 10*time.Second)
	if err != nil {
		return Config{}, err
	}

	config := Config{
		Component:          component,
		Version:            strings.TrimSpace(version),
		CandidateSourceSHA: strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CANDIDATE_SOURCE_SHA", version)),
		ArtifactDigest:     strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_ARTIFACT_DIGEST", "unknown")),
		ShutdownTimeout:    shutdownTimeout,
	}
	if component != ComponentConnector {
		config.StartupTimeout, err = durationFromEnv(lookup, "LOOMHELM_STARTUP_TIMEOUT", 30*time.Second)
		if err != nil {
			return Config{}, err
		}
		database, err := databaseConfigFromLookup(lookup)
		if err != nil {
			return Config{}, err
		}
		config.DatabaseURL = database.URL
		config.DatabaseMinConns = database.MinConns
		config.DatabaseMaxConns = database.MaxConns
	}

	switch component {
	case ComponentServer:
		config.HTTPAddr = lookupOrDefault(lookup, "LOOMHELM_HTTP_ADDR", "127.0.0.1:8080")
		config.DrainToken = lookupOrDefault(lookup, "LOOMHELM_DRAIN_TOKEN", "")
		config.BrowserAuth, err = browserAuthFromLookup(lookup)
		if err != nil {
			return Config{}, err
		}
		if err := validateListenAddress(config.HTTPAddr); err != nil {
			return Config{}, fmt.Errorf("invalid LOOMHELM_HTTP_ADDR: %w", err)
		}
	case ComponentWorker:
		config.WorkerHTTPAddr = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_WORKER_HTTP_ADDR", ""))
		config.DrainToken = lookupOrDefault(lookup, "LOOMHELM_DRAIN_TOKEN", "")
		if config.WorkerHTTPAddr != "" {
			if err := validateListenAddress(config.WorkerHTTPAddr); err != nil {
				return Config{}, fmt.Errorf("invalid LOOMHELM_WORKER_HTTP_ADDR: %w", err)
			}
		}
		generation, err := uint64FromEnv(lookup, "LOOMHELM_WORKER_GENERATION", 1)
		if err != nil {
			return Config{}, err
		}
		config.WorkerGeneration = generation
		config.WorkerLeaseKey = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_WORKER_LEASE_KEY", "loomhelm-worker"))
	case ComponentConnector:
		config.ConnectorServerURL = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CONNECTOR_SERVER_URL", ""))
		config.ConnectorHostID = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CONNECTOR_HOST_ID", ""))
		config.ConnectorToken = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CONNECTOR_TOKEN", ""))
		config.ConnectorJournalPath = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CONNECTOR_JOURNAL_PATH", ""))
		config.ConnectorAppServerCommand = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CONNECTOR_APP_SERVER_COMMAND", "codex"))
		if err := validateServerURL(config.ConnectorServerURL); err != nil {
			return Config{}, fmt.Errorf("invalid LOOMHELM_CONNECTOR_SERVER_URL: %w", err)
		}
	}

	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (c Config) Validate() error {
	if !isKnownComponent(c.Component) {
		return fmt.Errorf("unknown component %q", c.Component)
	}
	if strings.TrimSpace(c.Version) == "" {
		return fmt.Errorf("version must not be empty")
	}
	if strings.TrimSpace(c.CandidateSourceSHA) != "" && strings.ContainsAny(c.CandidateSourceSHA, " \t\r\n") {
		return fmt.Errorf("candidate source SHA must not contain whitespace")
	}
	if strings.TrimSpace(c.ArtifactDigest) != "" && strings.ContainsAny(c.ArtifactDigest, " \t\r\n") {
		return fmt.Errorf("artifact digest must not contain whitespace")
	}
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("shutdown timeout must be greater than zero")
	}

	switch c.Component {
	case ComponentServer:
		if err := c.BrowserAuth.Validate(); err != nil {
			return err
		}
		if err := validateListenAddress(c.HTTPAddr); err != nil {
			return fmt.Errorf("invalid HTTP address: %w", err)
		}
		if strings.TrimSpace(c.DrainToken) == "" {
			return fmt.Errorf("drain token must not be empty")
		}
		if strings.ContainsAny(c.DrainToken, " \t\r\n") {
			return fmt.Errorf("drain token must not contain whitespace")
		}
	case ComponentWorker:
		if c.WorkerGeneration == 0 {
			return fmt.Errorf("worker generation must be greater than zero")
		}
		if c.WorkerGeneration > math.MaxInt64 {
			return fmt.Errorf("worker generation must not exceed %d", int64(math.MaxInt64))
		}
		if strings.TrimSpace(c.WorkerHTTPAddr) != "" {
			if err := validateListenAddress(c.WorkerHTTPAddr); err != nil {
				return fmt.Errorf("invalid worker HTTP address: %w", err)
			}
			if strings.TrimSpace(c.DrainToken) == "" {
				return fmt.Errorf("drain token must not be empty when worker health is enabled")
			}
			if strings.ContainsAny(c.DrainToken, " \t\r\n") {
				return fmt.Errorf("drain token must not contain whitespace")
			}
		}
		if strings.TrimSpace(c.WorkerLeaseKey) != "" && strings.ContainsAny(c.WorkerLeaseKey, " \t\r\n") {
			return fmt.Errorf("worker lease key must not contain whitespace")
		}
	case ComponentConnector:
		if err := validateServerURL(c.ConnectorServerURL); err != nil {
			return fmt.Errorf("invalid connector server URL: %w", err)
		}
		if err := validateConnectorValue(c.ConnectorHostID, "connector host id", true); err != nil {
			return err
		}
		if err := validateConnectorValue(c.ConnectorToken, "connector token", true); err != nil {
			return err
		}
		if err := validateConnectorValue(c.ConnectorJournalPath, "connector journal path", false); err != nil {
			return err
		}
		if err := validateConnectorValue(c.ConnectorAppServerCommand, "connector app-server command", false); err != nil {
			return err
		}
	}
	if c.Component != ComponentConnector {
		database := DatabaseConfig{URL: c.DatabaseURL, MinConns: c.DatabaseMinConns, MaxConns: c.DatabaseMaxConns}
		if err := database.Validate(); err != nil {
			return err
		}
		if c.StartupTimeout < 0 {
			return fmt.Errorf("startup timeout must not be negative")
		}
	}
	return nil
}

// ValidateDevelopmentDatabaseTarget keeps an explicitly selected development
// port aligned with the application connection before any database is opened.
// Deployments that do not use the development Compose port leave it unset.
func ValidateDevelopmentDatabaseTarget(databaseURL, postgresPort string) error {
	if postgresPort == "" {
		return nil
	}
	port, err := strconv.ParseUint(strings.TrimSpace(postgresPort), 10, 16)
	if err != nil || port == 0 {
		return fmt.Errorf("LOOMHELM_POSTGRES_PORT must be an integer from 1 to 65535")
	}
	parsed, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("invalid LOOMHELM_DATABASE_URL")
	}
	if parsed.ConnConfig.Port != uint16(port) {
		return fmt.Errorf("LOOMHELM_DATABASE_URL port must match LOOMHELM_POSTGRES_PORT; update and export both from the same worktree environment")
	}
	return nil
}

// StartupBudget supplies the same default for environment and programmatic callers.
func (c Config) StartupBudget() time.Duration {
	if c.StartupTimeout == 0 {
		return 30 * time.Second
	}
	return c.StartupTimeout
}

func (c Config) CandidateSource() string {
	if source := strings.TrimSpace(c.CandidateSourceSHA); source != "" {
		return source
	}
	return strings.TrimSpace(c.Version)
}

func (c Config) CandidateArtifactDigest() string {
	if digest := strings.TrimSpace(c.ArtifactDigest); digest != "" {
		return digest
	}
	return "unknown"
}

func poolSizeFromEnv(lookup func(string) (string, bool), key string, fallback int32) (int32, error) {
	raw := lookupOrDefault(lookup, key, strconv.FormatInt(int64(fallback), 10))
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("%s must be a nonnegative 32-bit integer", key)
	}
	return int32(value), nil
}

func isKnownComponent(component Component) bool {
	switch component {
	case ComponentServer, ComponentWorker, ComponentConnector:
		return true
	default:
		return false
	}
}

func lookupOrDefault(lookup func(string) (string, bool), key, fallback string) string {
	value, ok := lookup(key)
	if !ok {
		return fallback
	}
	return value
}

func durationFromEnv(lookup func(string) (string, bool), key string, fallback time.Duration) (time.Duration, error) {
	raw := lookupOrDefault(lookup, key, fallback.String())
	duration, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: %w", key, raw, err)
	}
	if duration <= 0 {
		return 0, fmt.Errorf("%s must be greater than zero", key)
	}
	return duration, nil
}

func uint64FromEnv(lookup func(string) (string, bool), key string, fallback uint64) (uint64, error) {
	raw := lookupOrDefault(lookup, key, strconv.FormatUint(fallback, 10))
	value, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	if err != nil || value == 0 {
		if err != nil {
			return 0, fmt.Errorf("invalid %s %q: expected a positive integer", key, raw)
		}
		return 0, fmt.Errorf("%s must be greater than zero", key)
	}
	if value > math.MaxInt64 {
		return 0, fmt.Errorf("%s must not exceed %d", key, int64(math.MaxInt64))
	}
	return value, nil
}

func validateListenAddress(address string) error {
	if strings.TrimSpace(address) == "" {
		return fmt.Errorf("must not be empty")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("must be a host:port address: %w", err)
	}
	if host != strings.TrimSpace(host) || strings.ContainsAny(host, " \t\r\n") {
		return fmt.Errorf("host must not contain whitespace")
	}
	if strings.Contains(host, "/") {
		return fmt.Errorf("host must not contain a slash")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 0 || portNumber > 65535 {
		return fmt.Errorf("port must be an integer from 0 to 65535")
	}
	return nil
}

func validateServerURL(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("must not be empty")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("must be a valid URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("scheme must be https")
	}
	if parsed.Hostname() == "" {
		return fmt.Errorf("host must not be empty")
	}
	if parsed.User != nil {
		return fmt.Errorf("user information must not be included")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("query and fragment must not be included")
	}
	port, hasPort, err := explicitURLPort(parsed.Host)
	if err != nil {
		return err
	}
	if hasPort {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65535 {
			return fmt.Errorf("port must be an integer from 1 to 65535")
		}
	}
	return nil
}

func validateConnectorValue(value, field string, rejectWhitespace bool) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s must not be empty", field)
	}
	if rejectWhitespace && strings.ContainsAny(value, " \t\r\n") {
		return fmt.Errorf("%s must not contain whitespace", field)
	}
	return nil
}

func explicitURLPort(host string) (string, bool, error) {
	if strings.HasPrefix(host, "[") {
		closingBracket := strings.IndexByte(host, ']')
		if closingBracket < 0 {
			return "", false, fmt.Errorf("host must contain a closing bracket")
		}
		rest := host[closingBracket+1:]
		if rest == "" {
			return "", false, nil
		}
		if !strings.HasPrefix(rest, ":") {
			return "", false, fmt.Errorf("port must be an integer from 1 to 65535")
		}
		return rest[1:], true, nil
	}
	if strings.Count(host, ":") == 0 {
		return "", false, nil
	}
	if strings.Count(host, ":") != 1 {
		return "", false, fmt.Errorf("IPv6 hosts must be enclosed in brackets")
	}
	return host[strings.LastIndexByte(host, ':')+1:], true, nil
}
