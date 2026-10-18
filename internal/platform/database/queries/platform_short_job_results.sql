-- name: RecordShortJobResult :one
INSERT INTO platform_short_job_results (
    job_id,
    generation,
    payload
)
VALUES ($1, $2, $3)
ON CONFLICT (job_id) DO UPDATE SET
    generation = EXCLUDED.generation,
    payload = EXCLUDED.payload,
    completed_at = CURRENT_TIMESTAMP
RETURNING job_id, generation, payload, created_at, completed_at;

-- name: GetShortJobResult :one
SELECT job_id, generation, payload, created_at, completed_at
FROM platform_short_job_results
WHERE job_id = $1;
