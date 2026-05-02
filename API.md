# Claude Tuner API

The Claude Tuner extension communicates with the backend server at `api.claudetuner.com`. This document lists the endpoints used by the extension.

> **Note:** The server source code is not open source. This document describes the API surface for building compatible clients or understanding data flow.

## Authentication

All endpoints require an `X-API-Key` header. The default key is included in the extension configuration.

## Endpoints

### Snapshots

#### `POST /api/snapshots`

Submit a usage snapshot. This is the main data collection endpoint called every polling cycle.

**Headers:** `X-API-Key`, `Content-Type: application/json`

**Request body** includes (key fields):

| Field | Type | Description |
|-------|------|-------------|
| `user_email` | string | User's Claude.ai email |
| `five_hour_percent` | number | 5-hour window usage (0-100) |
| `seven_day_percent` | number | 7-day window usage (0-100) |
| `five_hour_resets_at` | string | ISO timestamp of 5h window reset |
| `seven_day_resets_at` | string | ISO timestamp of 7d window reset |
| `plan` | string | Current plan name (Pro, Max 5x, etc.) |
| `claude_org_uuid` | string | Organization UUID |
| `ext_version` | string | Extension version |
| `timezone` | string | User's IANA timezone |
| `language` | string | User's language (en/ko) |

**Response** includes recommendation data and admin plan orders if applicable.

#### `GET /api/snapshots/fitness?user_email={email}`

Get plan fitness analysis for the user.

**Response:** Fitness matrix with plan-specific scores and percentile rankings.

#### `PATCH /api/snapshots/admin-order-setting`

Update the user's plan change auto-approve preference.

**Body:** `{ "user_email": string, "auto_approve": boolean }`

#### `POST /api/snapshots/plan-order-response`

Report whether the user accepted or rejected a plan change request.

#### `POST /api/snapshots/plan-order-revert`

Notify server when a plan downgrade is cancelled.

#### `PATCH /api/snapshots/primary-org`

Set which organization is displayed as primary.

**Body:** `{ "user_email": string, "org_uuid": string }`

#### `POST /api/snapshots/dismiss`

Dismiss a recommendation notification.

#### `PATCH /api/snapshots/review-nudge`

Track user interaction with review prompt (clicked, dismissed).

### User Data

#### `GET /api/me?org={org_uuid}`

Get user's recent snapshots for bootstrapping local history cache. The `org` parameter is optional.

### Authentication

#### `POST /api/auth/ext-login`

Exchange Claude.ai email for a dashboard login token (SSO from extension to web dashboard).

**Body:** `{ "email": string }`

**Response:** `{ "token": string, "loginUrl": string }`

### Health

#### `POST /api/heartbeat`

Report collection errors to server for monitoring.

**Body:** `{ "user_email": string, "error": string, "ext_version": string }`

### Public

#### `GET /api/announcements`

Fetch active announcements for display in the popup.

**Response:** Array of announcement objects with title, body, type, and version filters.

#### `GET /api/uninstall?email=...&plan=...&v=...&days=...&lang=...`

Uninstall tracking endpoint (set via `chrome.runtime.setUninstallURL`). No auth required.

## Rate Limits

The server applies rate limiting per API key and per user email. Standard usage through the extension will not hit these limits.

## Building Compatible Clients

If you want to build a client (desktop app, CLI, etc.) that reads your own data:

1. Get your API key from the extension settings
2. Use `GET /api/me` to fetch your snapshots
3. Use `GET /api/snapshots/fitness` for plan analysis
4. `POST /api/snapshots` to submit new data points

The read endpoints (`GET`) are stable and suitable for third-party clients. Write endpoints (`POST/PATCH`) may change without notice.
