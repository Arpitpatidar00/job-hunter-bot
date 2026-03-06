# Production Issues Analysis

Based on the logs from `2026-03-06T15:33:26.851Z`, here is the breakdown of production issues categorized by severity.

## 🔴 Critical Severity
These issues directly impact the core functionality of the bot and can cause complete failure of specific execution cycles or data loss.

### 1. Worker CPU Exceeded Limit
*   **Log Message:** `Worker exceeded CPU time limit.`
*   **Outcome:** `exceededCpu`
*   **Impact:** The worker process gets killed before completing its task. This usually happens in the `feed-queue` when evaluating and parsing large amounts of content, preventing jobs from being processed or alerts from being sent.
*   **Recommendation:** Optimize processing logic in the feed-queue, handle feeds in smaller batches, or offload heavy parsing to another service.

### 2. Database (D1) Foreign Key Constraint Failure
*   **Log Message:** `[ERROR] [D1] Failed to mark alert sent: D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`
*   **Impact:** The system failed to update the alert status in the database because a referenced record (e.g., job or user) does not exist or was deleted. This could lead to duplicate alerts being sent.
*   **Recommendation:** Verify the integrity of the data being passed to the alert update function. Ensure the referenced IDs exist in the database before attempting to insert or update.

## 🟠 High Severity
These issues cause significant degradation in performance and may result in skipped jobs, but the system has fallback mechanisms in place.

### 3. Queue Send Rate Limiting (Too Many Requests)
*   **Log Message:** 
    * `[ERROR] [Producer] Queue send failed: Queue sendBatch failed: Too Many Requests. Falling back to DIRECT processing.`
    * `[ERROR] [Fetcher] JOB_QUEUE send failed: Queue send failed: Too Many Requests. Falling back to direct evaluation.`
*   **Impact:** Cloudflare Queues are rate-limiting the insertions. The system falls back to direct execution, which significantly increases the risk of hitting CPU time limits (see Critical issue #1).
*   **Recommendation:** Implement exponential backoff for queue insertions, or pace the producer to stay within Cloudflare Queue rate limits.

### 4. Queue Payload Too Large
*   **Log Message:** `[ERROR] [Fetcher] JOB_QUEUE send failed: Queue send failed: Payload Too Large. Falling back to direct evaluation.`
*   **Impact:** The data being sent to the Queue exceeds the maximum payload size (usually 128KB). Similar to rate-limiting, the system falls back to direct execution, increasing CPU load and the likelihood of execution timeouts.
*   **Recommendation:** Reduce the size of the payload being sent to the queue. Send only references (e.g., Job IDs) instead of full job descriptions.

## 🟡 Medium Severity
These issues affect specific features (like AI embeddings) but do not stop the core job hunting process.

### 5. AI Service Subrequest Limit
*   **Log Message:** `[ERROR] [AI] Failed to generate embedding: Too many subrequests.`
*   **Impact:** The Worker exceeded the maximum allowable subrequests (external API calls) while trying to generate embeddings. Some jobs will not have embeddings generated for them.
*   **Recommendation:** Batch AI embedding requests if possible or pace the subrequests to stay within Cloudflare Worker subrequest limits (typically 50-100 per request).

### 6. AI Model Temporarily Unavailable
*   **Log Message:** `[ERROR] [AI] Failed to generate embedding: 9000: model temporarily unavailable`
*   **Impact:** The Cloudflare AI model used for embeddings is temporarily down. Affected jobs will lack embeddings.
*   **Recommendation:** Add retry logic with backoff, or implement a fallback mechanism where embeddings are generated offline or skipped gracefully.

## 🟢 Low Severity
These are operational or contextual errors that do not immediately crash the application but indicate execution context issues.

### 7. Generic Context / Cron Errors
*   **Log Message:** `"0,15,30,45 * * * *"` or `"feed-queue"` logged with `error` level
*   **Impact:** Event failures where only the cron trigger or queue name is logged instead of an actual error description. This indicates a poorly handled exception at the top level of the worker.
*   **Recommendation:** Improve global error handling/try-catch blocks in the cron and queue event listeners to ensure descriptive error messages and stack traces are logged.
