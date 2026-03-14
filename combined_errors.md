# Combined Application Errors

After analyzing the latest `error.csv` file, here are the deduplicated, distinct errors that have been occurring repeatedly:

### 1. Fetcher Queue Rate Limiting
**Error Message:**
> `[ERROR] [Fetcher] JOB_QUEUE sendBatch failed after retries: Queue sendBatch failed: Too Many Requests. Falling back to direct evaluation.`

**Context:** The application is hitting Cloudflare Queue rate limits when the Fetcher attempts to send batches. It recovers by falling back to direct evaluation.

### 2. Producer Queue Rate Limiting
**Error Message:**
> `[ERROR] [Producer] Queue send failed after retries: Queue sendBatch failed: Too Many Requests. Falling back to DIRECT processing.`

**Context:** Similarly, the Producer component is hitting Cloudflare Queue rate limits ("Too Many Requests") when sending batches, failing over to direct processing.

### 3. Exceeded CPU Threshold (Cron Execution)
**Error Message:**
> `"0,15,30,45 * * * * "` (Logged alongside an `$workers.outcome` of `exceededCpu`)

**Context:** Several cron executions on the `0,15,30,45 * * * *` schedule are failing with an `exceededCpu` outcome. The application is hitting Cloudflare Workers' CPU limits during these scheduled runs.
