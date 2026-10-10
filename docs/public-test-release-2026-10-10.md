# Public test release — 2026-10-10

New accounts default to personal API configuration (allowOwn=true, modelSource=own). Shared model use is blocked for ordinary users, including previously granted users; explicit administrator revocation of personal access remains respected.

The shared configuration form supports provider ID, display name, public HTTPS API URL, Chat Completions / Responses / Anthropic Messages, masked credentials, model catalog discovery and manually entered model IDs. Catalog fetching is optional and never sends credentials to the account service.

Model keys are encrypted per account and never echoed by settings APIs. A blank field retains a saved key; clearing is explicit. Legacy plaintext local configuration migrates only to the host identity, never to an arbitrary signed-in account. Local encryption uses a key in the application data directory; protect that directory with OS account permissions and exclude it from backups shared with others.

Task routes (including nested patches), dataset bundles, UI history and preference records are isolated by authenticated account. Invalid delegated tokens fail closed. Provider requests validate all DNS answers and pin an approved public address to the TLS connection, reject redirects and limit response size. Authentication attempts are rate limited; bootstrap administrator credentials are excluded from logs. Abandoned uploads support owner-checked deletion, six-hour expiry, and restart cleanup.

Desktop/plugins retain local projects by default. Web execution uploads input files to the application server. The selected external model receives prompts and column metadata; do not include confidential records in prompts. Public support: spark_sight@163.com.

Deployment must use production mode (REMOTE_MODE=1 or LOCAL_AGENT_WEB_ONLY=1), never TEST_WEB_MODE=1, a private persistent data directory and strong administrator credentials. TLS is terminated by the production reverse proxy. Auth rate limiting uses the socket IP; when proxying, requests may share this limit. Configure an additional proxy rate limit as appropriate.

Source maps, local release configuration, secret files, runtime data, logs, caches and screenshots are excluded from published source/package allowlists. The public plugin checkout keeps deployment origins in ignored local release configuration, with public HTTPS origins only in the distributable VSIX.

This is a targeted code review and automated validation, not a claim of independent penetration testing or a production deployment. GitHub updates do not automatically prove that the running server has restarted with this revision.
