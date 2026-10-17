package platform

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Component string

const (
	ComponentServer    Component = "server"
	ComponentWorker    Component = "worker"
	ComponentConnector Component = "connector"
)

type Config struct {
	Component          Component
	Version            string
	HTTPAddr           string
	ShutdownTimeout    time.Duration
	WorkerGeneration   uint64
	ConnectorServerURL string
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
		Component:       component,
		Version:         strings.TrimSpace(version),
		ShutdownTimeout: shutdownTimeout,
	}

	switch component {
	case ComponentServer:
		config.HTTPAddr = lookupOrDefault(lookup, "LOOMHELM_HTTP_ADDR", "127.0.0.1:8080")
		if err := validateListenAddress(config.HTTPAddr); err != nil {
			return Config{}, fmt.Errorf("invalid LOOMHELM_HTTP_ADDR: %w", err)
		}
	case ComponentWorker:
		generation, err := uint64FromEnv(lookup, "LOOMHELM_WORKER_GENERATION", 1)
		if err != nil {
			return Config{}, err
		}
		config.WorkerGeneration = generation
	case ComponentConnector:
		config.ConnectorServerURL = strings.TrimSpace(lookupOrDefault(lookup, "LOOMHELM_CONNECTOR_SERVER_URL", ""))
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
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("shutdown timeout must be greater than zero")
	}

	switch c.Component {
	case ComponentServer:
		if err := validateListenAddress(c.HTTPAddr); err != nil {
			return fmt.Errorf("invalid HTTP address: %w", err)
		}
	case ComponentWorker:
		if c.WorkerGeneration == 0 {
			return fmt.Errorf("worker generation must be greater than zero")
		}
	case ComponentConnector:
		if err := validateServerURL(c.ConnectorServerURL); err != nil {
			return fmt.Errorf("invalid connector server URL: %w", err)
		}
	}
	return nil
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
	if strings.HasSuffix(parsed.Host, ":") {
		return fmt.Errorf("port must be an integer from 1 to 65535")
	}
	if port := parsed.Port(); port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65535 {
			return fmt.Errorf("port must be an integer from 1 to 65535")
		}
	}
	return nil
}
