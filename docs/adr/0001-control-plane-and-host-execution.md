# ADR 0001: Go control plane and host-local execution

Status: Accepted

## Context

Loomhelm needs one project and permission model for Web, HTTP and MCP while Codex executes on selected machines. The owner selected the Go ecosystem for the backend and Bun for frontend engineering. Codex authentication and execution must remain associated with the chosen host.

## Decision

Use separate Go Server, Worker and Connector processes. Server exposes chi HTTP and shared application entry points; PostgreSQL stores durable business and execution facts through pgx/sqlc and goose. River carries bounded dispatch/reconciliation work rather than owning the lifetime of a Codex turn.

Connector initiates an authenticated outbound platform connection and adapts host-local Codex app-server communication. Command identity, durable recording and reconciliation connect accepted requests to observed execution. The platform exposes uncertainty when execution cannot be proven. Existing desktop live control requires same-instance evidence before the adapter is considered supported.

Build the React/Vite Web/PWA with Bun workspaces and generated TypeScript clients. Frontend tooling does not require a Node.js business backend. REST and MCP share application behavior and project permissions.

## Consequences

The deployment and authentication contracts cover three independently restarting processes, and queue completion does not imply Codex completion. This adds explicit reconciliation work but centralizes durable truth and avoids forwarding host Codex credentials to the platform. A single persistent database is sufficient for the initial small-team deployment; a distributed consensus layer is not introduced.
