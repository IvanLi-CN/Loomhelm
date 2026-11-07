// Package buildinfo owns immutable product identity, separate from state schemas.
package buildinfo

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Values are injected by the product builder. Source checkouts remain dev.
var Version = "dev"
var SourceSHA = "unknown"
var Policy = "loomhelm-manual-v1"

const Header = "X-Loomhelm-Version"

var semver = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$`)
var sha = regexp.MustCompile(`^[0-9a-f]{40}$`)

func validVersion(value string) bool {
	if !semver.MatchString(value) {
		return false
	}
	_, pre, found := strings.Cut(value, "-")
	if found {
		for _, part := range strings.Split(pre, ".") {
			if len(part) > 1 && part[0] == '0' && strings.Trim(part, "0123456789") == "" {
				return false
			}
		}
	}
	return true
}

func Validate(version, source string) error {
	if version == "dev" {
		return nil
	}
	if !validVersion(version) || !sha.MatchString(source) {
		return fmt.Errorf("invalid immutable release build identity")
	}
	return nil
}

func ValidateOverride(version, source string) error {
	if err := Validate(Version, SourceSHA); err != nil {
		return err
	}
	if Version != "dev" && (version != Version || source != SourceSHA) {
		return fmt.Errorf("runtime identity differs from immutable build")
	}
	return nil
}

// Compatible is deliberately exact until a tested policy explicitly adds pairs.
func Compatible(server, client string) bool {
	return server == "dev" || (validVersion(client) && client == server)
}

func PrintVersion(args []string, writer io.Writer) bool {
	if len(args) != 1 || (args[0] != "--version" && args[0] != "version") {
		return false
	}
	_ = json.NewEncoder(writer).Encode(map[string]string{"version": Version, "source_sha": SourceSHA, "policy": Policy})
	return true
}
