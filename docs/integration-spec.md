# X page integration contract

This document defines the behavior Feedpecker requires from its page-context
adapter. It is an implementation contract, not user documentation. The adapter
may be replaced freely as long as these observable behaviors remain true.

## Scope

The adapter runs only in an `x.com` page and provides four capabilities:

1. Observe X API responses already requested by the page and extract useful
   account facts without delaying those requests.
2. Look up X's "About this account" metadata for a requested username.
3. Perform a user-requested block or unblock action.
4. report lookup and action rate-limit information.

It does not persist data, contact a Feedpecker service, or send authentication
material through the extension bridge.

## Trust and privacy boundaries

- The page adapter communicates with the content script through one private
  `MessagePort` negotiated with a random bridge identifier.
- The bridge is accepted only from the same window and same origin.
- Only these request headers may be read for same-origin X requests:
  `authorization`, `x-csrf-token`, `x-twitter-active-user`,
  `x-twitter-auth-type`, `x-twitter-client-language`, `accept`, and
  `content-type`.
- Cookies, bearer tokens, and captured headers must never be sent through the
  bridge or written to extension storage.
- Usernames must match `^[A-Za-z0-9_]{1,15}$` after removing one leading `@`.
- GraphQL operation identifiers must match `^[A-Za-z0-9_-]{8,128}$`.

## Bridge initialization

The page sends a same-origin window message with:

```text
target: contentScript
type: __feedpeckerBridgeRequest
bridgeId: a random UUID
```

The content script replies with exactly one transferred port and:

```text
target: pageScript
type: __feedpeckerBridgeInit
bridgeId: the same UUID
```

After accepting the port, the page sends `__bridgeReady`. Messages produced
before connection are queued with a bounded queue.

## Requests accepted from the content script

### `__fetchUserData`

Input: `screenName`, `requestId`.

`requestId` must be a version-4 UUID. The adapter discovers the current
AboutAccount operation ID from observed requests, resource timing entries,
inline scripts, or loaded webpack modules. If none is available, it tries a
short built-in candidate list and retires stale candidates after a failed
request. It then performs a credentialed same-origin GET and sends exactly one
`__userDataResponse` for the request.

Successful output fields:

- `screenName`
- `requestId`
- `location`: account-based country or region, or `null`
- `verified`: boolean
- `following`: boolean or `null`
- `is_region`: boolean
- `confirmed: true`

Failure output fields include `failure` and may include `retryable` and
`isRateLimited`. Invalid requests fail without making a network request.

### `__blockUser` and `__unblockUser`

Input: `screenName`, `actionId`, and optional `source` (`manual` or `auto`).

Perform the corresponding X v1.1 account action with the active X session and
send one `__accountActionResult` containing `ok`, HTTP `status`, action fields,
and any rate-limit values returned by X.

## Events sent to the content script

- `__bridgeReady`: the private channel is available.
- `__passiveData`: zero or more normalized account records found in an X JSON
  response. Empty batches are not sent.
- `__userDataResponse`: terminal response for one explicit lookup.
- `__rateLimitInfo`: current lookup allowance reported by X.
- `__accountActionResult`: terminal response for one block/unblock request.
- `__debugLog`: non-sensitive diagnostics only.

Normalized passive records use `screen_name`, `location`, `verified`,
`following`, `utc_offset`, `time_zone`, and `is_region`.

## Rate-limit behavior

- Parse `x-rate-limit-limit`, `x-rate-limit-remaining`, and
  `x-rate-limit-reset` on every explicit lookup and account action.
- HTTP 429 is authoritative even when headers are incomplete.
- Treat reset values as Unix seconds. Only when a 429 response omits a valid
  reset value may the adapter report a conservative 60-second fallback.
- A stale AboutAccount operation ID may be discarded after HTTP 400 or 404 and
  rediscovered once. Never loop retries.

## Acceptance checks

1. A malformed username, query ID, or lookup request ID causes no API call.
2. Page API requests behave identically when response observation fails.
3. No authorization or CSRF value appears in bridge messages or storage.
4. A valid AboutAccount result is normalized even when fields occur in legacy
   or nested user objects.
5. HTTP 429 produces both terminal lookup output and rate-limit state.
6. A block/unblock request produces one terminal result on success, HTTP
   failure, timeout, or network failure.
7. Repeated bridge requests stop after connection or after a bounded number of
   attempts.
8. Operation identifiers never cross the extension bridge or enter extension
   storage; stale candidates are session-local.
