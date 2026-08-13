# Security model

Feedpecker is a powerful browser extension because it runs on X pages and can optionally perform account actions through your authenticated X session. This document describes the intended boundary of the current source code.

## What the extension can access

- Page content and X API responses on `x.com` and `twitter.com`.
- Supported account metadata used for location flags and filtering.
- Its own local extension storage and X-page IndexedDB cache.
- X block and unblock endpoints when you explicitly request an action or enable Auto-block.
- The public repository release API on `api.github.com` for a startup version comparison.

It does not request access to arbitrary websites, general tab metadata, browser history, downloads, the clipboard, or the browser's cookie API.

## Network boundary

The extension has no developer-operated backend, telemetry endpoint, remotely hosted executable code, or shared account database. Runtime requests are limited to X-owned services and a read-only request for public release metadata from GitHub. The response is parsed as data and is never executed. Flag SVGs are bundled locally.

## Page integration

X account metadata is available inside the page's JavaScript environment, so `pageScript.js` runs in the page's `MAIN` world. This is an inherently higher-trust context than an isolated extension script.

The isolated content script and `pageScript.js` establish a dedicated `MessageChannel` during startup. Location results and block/unblock commands then use the transferred port instead of accepting privileged commands from the page's global message stream. Incoming handles, query IDs, backup data, and runtime messages are validated and bounded.

This bridge limits message spoofing, but it cannot make a script running in X's own JavaScript world independent from X itself. A compromised X page, browser, operating system, or another highly privileged extension remains outside this project's protection.

## Account-action safeguards

- Auto-block is disabled by default.
- Enabling Auto-block requires confirmation.
- Individual and bulk actions require explicit confirmation.
- Bulk actions are paced and stop when X rejects or rate-limits a request.
- Screen names are validated again at the final X-action boundary.

## Local data

Stored handles, inferred locations, analytics, and logs are not encrypted. JSON backups contain portable data in readable form and should be kept private. Imports are size-limited, schema-filtered, and capped before replacing local data.

## Installing safely

Install from the official repository, inspect the commit you intend to run, and reload the unpacked extension only after reviewing updates. An unpacked build does not silently receive store updates.

## Reporting a vulnerability

Do not include account cookies, authorization headers, backup files, or private profile data in a public issue. Describe the affected component and reproduction steps with placeholder accounts and sanitized logs.
