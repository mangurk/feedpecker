# Privacy

Feedpecker is designed as a local-first browser extension.

## Data stored locally

The extension stores the following in browser extension storage or IndexedDB:

- extension settings and selected country rules;
- cached account-location results;
- feed-geography and filtering counters;
- filtered-profile history, per-profile Hide/Show overrides, and known block status;
- local diagnostic logs retained for up to 24 hours;
- request-budget and rate-limit state.

Manual JSON backups are created only when you click **Download backup**. The extension does not upload backup files.

## Network boundary

The extension has no developer-operated backend, telemetry endpoint, shared profile database, or third-party location service.

Firefox classifies the requests made to X as transmission of website activity and website content. The Firefox manifest declares those categories explicitly; they refer to the X requests described below, not to developer collection or a separate backend.

Network requests are limited to X-owned services used for the extension's core behavior and one public GitHub version check:

- X account metadata and location lookups through the authenticated session already open in your browser;
- X block or unblock actions that you explicitly request or enable through Auto-block;
- this repository's latest public GitHub Release metadata from `api.github.com`, used to compare version numbers and display release notes.

Flag SVG artwork is bundled with the extension and creates no network request.

X receives its requests under your existing X session and its own privacy terms. GitHub receives an ordinary request for public release metadata, including normal network metadata such as your IP address and user agent, under GitHub's privacy terms. The extension does not place discovered usernames, locations, settings, analytics, logs, or backups in that request or send them to this project's developer.

## Page data and sensitive content

The page integration observes X API responses in memory to extract supported account metadata. It does not intentionally extract or store post text, Direct Message text, passwords, or email addresses. Its host access is limited to `x.com` and `twitter.com` pages declared in `manifest.json`.

Privileged communication between the isolated extension script and the X-page integration uses a dedicated `MessageChannel` after a one-time startup handshake. See [SECURITY.md](SECURITY.md) for the complete trust model and its limits.

## Removing local data

You can reset dashboard analytics from the dashboard. Removing the unpacked extension removes its extension-managed local storage; browser behavior for site-scoped IndexedDB may vary.
