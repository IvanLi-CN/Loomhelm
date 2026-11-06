package migrations

import "embed"

// FS contains the application migrations owned by this repository.
// River's queue schema is migrated separately by the jobs adapter.
//
//go:embed *.sql
var FS embed.FS
