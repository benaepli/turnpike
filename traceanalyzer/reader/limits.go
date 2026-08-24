package reader

import (
	"net/url"
	"os"
	"path/filepath"
)

// duckDBDSNOptions bounds DuckDB's resource use. Left unconfigured it defaults
// memory_limit to 80% of physical RAM; the temp directory lets large queries
// spill to disk instead of failing.
func duckDBDSNOptions() string {
	tempDir := envOr("SPUR_DUCKDB_TEMP_DIR", filepath.Join(os.TempDir(), "spur-duckdb"))
	_ = os.MkdirAll(tempDir, 0o755)

	q := url.Values{}
	q.Set("memory_limit", envOr("SPUR_DUCKDB_MEMORY_LIMIT", "4GB"))
	q.Set("threads", envOr("SPUR_DUCKDB_THREADS", "4"))
	q.Set("temp_directory", tempDir)
	// No query here depends on scan order; this cuts memory on large scans.
	q.Set("preserve_insertion_order", "false")
	return "?" + q.Encode()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
