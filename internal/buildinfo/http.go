package buildinfo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// Guard rejects before invoking any application handler or upgrade.
func Guard(version string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(Header, version)
		w.Header().Set("Cache-Control", "no-store")
		if !Compatible(version, r.Header.Get(Header)) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUpgradeRequired)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "PRODUCT_VERSION_INCOMPATIBLE", "message": "Update the client before reconnecting; local state is preserved.", "server_version": version})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// CheckServer is run on each new connection; credentials are not sent to /version.
func CheckServer(ctx context.Context, client *http.Client, endpoint string) error {
	if Version == "dev" {
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Cache-Control", "no-cache")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var info struct {
		Version string `json:"version"`
		Policy  string `json:"policy"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(http.MaxBytesReader(nil, response.Body, 16384)).Decode(&info) != nil || info.Policy != Policy || !Compatible(Version, info.Version) {
		return fmt.Errorf("PRODUCT_VERSION_INCOMPATIBLE: update the client before reconnecting")
	}
	return nil
}
