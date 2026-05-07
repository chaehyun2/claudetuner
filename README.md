<p align="center">
  <img src="icons/icon128.png" alt="Claude Tuner" width="80" />
</p>

<h1 align="center">Claude Tuner</h1>

<p align="center">
  Track your Claude usage limits in real time — across Chat, Code, Cowork, and Design.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond"><img src="https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Web Store" /></a>
  <a href="https://claudetuner.com/dashboard/?demo=true"><img src="https://img.shields.io/badge/Live_Demo-Dashboard-FF6B35" alt="Live Demo" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chaehyun2/claudetuner" alt="License" /></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/lang-한국어-blue" alt="Korean" /></a>
</p>

<p align="center">
  Trusted by thousands of Claude Pro, Max, Team, and Enterprise users worldwide.
</p>

---

<!-- TODO: Replace with actual screenshots -->
<!-- Recommended: 1 popup screenshot + 1 dashboard screenshot, side by side -->
<!-- Example: -->
<!-- <p align="center"> -->
<!--   <img src="docs/screenshots/popup.png" alt="Popup" width="280" /> -->
<!--   &nbsp;&nbsp;&nbsp;&nbsp; -->
<!--   <img src="docs/screenshots/dashboard.png" alt="Dashboard" width="480" /> -->
<!-- </p> -->

## Why Claude Tuner?

Claude's rate limits are opaque — you don't know how much you've used, when it resets, or whether your plan is right for you. Claude Tuner fixes that.

- **See your limits** — live 5h / 7d usage gauges with reset countdowns
- **Predict resets** — know if you'll hit the cap before the window rolls over
- **Find the right plan** — "what if" simulations across Pro, Max 5x, and Max 20x
- **Monitor your team** — free dashboard with per-member analytics, breach tracking, and group comparisons

## Screenshots

<!-- TODO: Add actual screenshots. Suggested images: -->
<!-- 1. Extension popup showing usage gauges -->
<!-- 2. Dashboard overview with charts -->
<!-- 3. Team dashboard with member list -->
<!-- 4. Plan simulation / recommendation -->

| Extension Popup | Web Dashboard |
|:-:|:-:|
| *screenshot coming soon* | *screenshot coming soon* |

| Plan Simulator | Team Dashboard |
|:-:|:-:|
| *screenshot coming soon* | *screenshot coming soon* |

## Features

<details open>
<summary><b>Real-Time Usage Monitoring</b></summary>

- Live 5-hour and 7-day usage gauges
- Reset countdown timers
- Toolbar badge showing current usage level
- 6-tier pace indicator (safe → critical)
- Sparkline charts for usage trends
- Multi-organization support (auto-detect or pin)
</details>

<details open>
<summary><b>Smart Alerts & Predictions</b></summary>

- Usage prediction at reset based on consumption rate
- Configurable threshold notifications (80%, 95%)
- Weekly usage reports via email
- Estimated token breakdown (Opus / Sonnet / Haiku)
- Peak hours indicator (weekday 12:00–18:00 UTC)
- Real-time 429 rate limit detection
</details>

<details>
<summary><b>Plan Simulation & Optimizer</b></summary>

- "What if" simulation for every plan (Pro / Max 5x / Max 20x)
- Visual exceeded-days comparison
- Smart upgrade/downgrade recommendations
- Cost-efficiency analysis
</details>

<details>
<summary><b>Plan Fitness Score</b></summary>

- At-a-glance fitness rating for your subscription
- Percentile ranking among Claude Tuner users
- Usage distribution histogram
</details>

<details>
<summary><b>Hourly Activity Heatmap</b></summary>

- 24×7 heatmap of your Claude usage patterns
- Peak hours and quiet periods at a glance
- Weekday vs weekend comparison
</details>

<details>
<summary><b>Team Dashboard</b> — free for all members</summary>

- Per-member usage analytics and rate limit tracking
- Token usage leaderboard and cost analytics
- Breach tracking with plan upgrade/downgrade recommendations
- Group-based usage comparison analysis
- Daily team reports and weekly personal reports
- Training data policy monitoring
- Domain-based auto-invite and group management (admin)
- CSV / Excel export
</details>

## Supported Plans

| Plan | 5h Limit | 7d Limit | Extras |
|------|----------|----------|--------|
| Pro (1x) | ● | ● | — |
| Max 5x | ● | ● | — |
| Max 20x | ● | ● | — |
| Team Standard | ● | ● | — |
| Team Premium | ● | ● | — |
| Enterprise (seat-based) | ● | ● | Spending cap |
| Enterprise (usage-based) | — | — | Spending cap |

## Install

### Chrome Web Store (recommended)

<a href="https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond">
  <img src="https://img.shields.io/badge/Install_from-Chrome_Web_Store-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Install from Chrome Web Store" />
</a>

### Manual install (developer mode)

```bash
git clone https://github.com/chaehyun2/claudetuner.git
```

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the cloned folder

## How It Works

```
You ──→ Claude.ai ──→ Claude Tuner extension ──→ Claude Tuner API server
                        (reads usage data)         (stores history & analytics)
                              │
                              ▼
                        Extension popup          Web dashboard
                       (gauges & alerts)     (charts, team, insights)
```

1. **Collect** — The extension reads your usage data from Claude.ai (no conversation content, ever)
2. **Analyze** — Snapshots are sent to the API server, which stores history and computes analytics
3. **Display** — View real-time gauges in the popup, or dive deep on the [web dashboard](https://claudetuner.com/dashboard)

## Self-Hosting

Point the extension at your own server by editing `config.js`:

```js
const CT_CONFIG = {
  DEFAULT_SERVER_URL: 'https://your-server.example.com',
  DEFAULT_API_KEY: 'your-api-key',
  SITE_URL: 'https://your-dashboard.example.com',
};
```

See [API.md](API.md) for the full server API specification.

## Privacy

- **No conversation content** is ever collected — no messages, files, or prompts
- Only usage metrics, reset timestamps, plan info, and organization membership
- Self-service account deletion available anytime
- Full privacy policy: [claudetuner.com/privacy](https://claudetuner.com/privacy/)

<details>
<summary><b>Architecture</b></summary>

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

**No build step** — the source files in this repo are identical to what's published on the Chrome Web Store.

</details>

<details>
<summary><b>Verify CWS Build</b></summary>

This extension has no build step. The files in this repository are byte-for-byte identical to the Chrome Web Store package, with one intentional difference: `manifest.json` in the private development repo includes a `pages.dev` preview URL in `externally_connectable` that is stripped during publishing.

To verify:

1. Install the extension from CWS
2. Find the installed files at `~/Library/Google/Chrome/Default/Extensions/ajnnckikagphjbgpicpoffockabnhond/<version>/`
3. Compare with this repository (excluding `_metadata/` added by Chrome)

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

<sub>Claude Tuner is not affiliated with or endorsed by Anthropic. Token limits are community-observed estimates, not official figures.</sub>
