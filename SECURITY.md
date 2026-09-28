# Security

QiScreenwrite is a personal local application. Its desktop service binds to loopback, checks the request origin and uses a private owner credential. Do not expose it directly to the internet or disable its origin/authentication checks for convenience.

Treat screenplay libraries, recovery data, exports, rights attachments and backups as private files. Keep independent backups. The software does not add an online account, telemetry service or cloud backup to local authoring.

Do not publish secrets or private writing in an issue. To report a vulnerability, use GitHub’s **Security → Report a vulnerability** if private reporting is available for this repository. Otherwise, open a minimal issue asking the maintainer for a private reporting channel, without exploit details or sensitive data. No response-time commitment is currently established.

Reports should identify the version/commit, affected workflow, reproducible synthetic example and the actual impact. A development build or passing test suite is not a security certification.
