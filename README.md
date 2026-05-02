# Claude Tuner

[Chrome Web Store](https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond) | [Dashboard](https://claudetuner.com/dashboard/?demo=true) | [Korean / 한국어](README-ko.md)

Chrome extension that tracks your Claude AI usage in real time — monitor rate limits, predict resets, and find the right plan.

Trusted by thousands of Claude Pro, Max, and Team users worldwide.

## Features

**Real-Time Usage Monitoring**
- Live 5-hour and 7-day usage gauges
- Reset countdown timers
- Toolbar badge showing current usage level
- Sparkline charts for usage trends

**Smart Alerts & Predictions**
- Usage prediction at reset based on consumption rate
- Configurable threshold notifications (80%, 95%)
- Weekly usage reports
- Estimated token breakdown (Opus / Sonnet / Haiku)

**Plan Simulation & Optimizer**
- "What if" simulation for every plan (Pro / Max 5x / Max 20x)
- Visual exceeded-days comparison
- Smart upgrade/downgrade recommendations
- Cost-efficiency analysis

**Plan Fitness Score**
- At-a-glance fitness rating for your subscription
- Percentile ranking among Claude Tuner users
- Usage distribution histogram

**Hourly Activity Heatmap**
- 24x7 heatmap of your Claude usage patterns
- Peak hours and quiet periods
- Weekday vs weekend comparison

**Team Dashboard** (free for admins)
- Per-member usage analytics and rate limit tracking
- Token usage leaderboard and cost analytics
- Plan change requests for team members
- Group management and domain-based auto-invite
- CSV / Excel export

## Supported Plans

- Pro (1x) / Max 5x / Max 20x
- Team Standard / Team Premium
- Enterprise (view-only)

## Install

**Chrome Web Store** (recommended):

[Install Claude Tuner](https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond)

**Manual install** (developer mode):

1. Clone this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the cloned folder

## Architecture

```
popup.html/js          Popup UI (usage gauges, charts, recommendations)
options.html/js        Settings page (intervals, alerts, org selection)
background.js          Service worker (alarm scheduling, message routing)
  bg/collect.js        Main collection engine (Claude.ai API -> server)
  bg/plan.js           Plan detection, change execution, recommendations
  bg/api.js            Claude.ai API wrapper (dual auth fallback)
  bg/storage.js        Chrome storage helpers
  bg/constants.js      Configuration constants
  bg/badge.js          Toolbar badge updates
  bg/notifications.js  Usage alerts, reset notifications
  bg/analytics.js      GA4 event tracking
config.js              Centralized config (server URL, API key)
content.js             Content script (message relay)
page-script.js         Injected into Claude.ai (fetch with page auth)
i18n.js                Localization helper
_locales/              English and Korean translations
```

The extension collects usage data from Claude.ai and sends snapshots to the Claude Tuner API server. The server stores history, generates analytics, and powers the [web dashboard](https://claudetuner.com/dashboard).

**No build step** — the source files in this repo are identical to what's published on the Chrome Web Store.

## Self-Hosting

To point the extension at your own server, edit `config.js` and `bg/constants.js`:

```js
// config.js
const CT_CONFIG = {
  DEFAULT_SERVER_URL: 'https://your-server.example.com',
  DEFAULT_API_KEY: 'your-api-key',
  SITE_URL: 'https://your-dashboard.example.com',
};
```

See [API.md](API.md) for the server API specification.

## Privacy

- **No conversation content** is ever collected — no messages, files, or prompts
- Only usage percentages, reset timestamps, and plan information
- Self-service account deletion available anytime
- Full privacy policy: https://claudetuner.com/privacy/

## Verify CWS Build

This extension has no build step. The files in this repository are byte-for-byte identical to the Chrome Web Store package, with one intentional difference: `manifest.json` in the private development repo includes a `pages.dev` preview URL in `externally_connectable` that is stripped during publishing.

To verify:

1. Install the extension from CWS
2. Find the installed files at `~/Library/Google/Chrome/Default/Extensions/ajnnckikagphjbgpicpoffockabnhond/<version>/`
3. Compare with this repository (excluding `_metadata/` added by Chrome)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Claude Tuner is not affiliated with or endorsed by Anthropic.
Token limits are community-observed estimates, not official figures.
