# Loomhelm Connector for macOS Apple silicon

Run this binary on the computer that owns the Codex CLI and app-server process. The default platform is `https://loomhelm.ivanli.cc`; set `LOOMHELM_CONNECTOR_BASE_URL` only when using another Loomhelm Server. `LOOMHELM_CONNECTOR_API_KEY` is optional.

```sh
LOOMHELM_CONNECTOR_BASE_URL=https://loomhelm.ivanli.cc ./loomhelm-connector
```

When no API key or private local cache exists, the Connector opens the browser for a one-time device authorization and stores the resulting host credential in the user configuration directory. Keep the local `codex` command available in `PATH` and complete Codex login on this computer before starting the Connector.
