<p align="center">
  <img src="icons/icon128.png" alt="Claude Tuner" width="80" />
</p>

<h1 align="center">Claude Tuner</h1>

<p align="center">
  Know <i>when</i> you'll hit your Claude, ChatGPT & Gemini limits — live gauges, reset forecasts,
  and the usage history none of them show you. One extension, every AI, personal and team.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond"><img src="https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Web Store" /></a>
  <a href="https://claudetuner.com/dashboard/?demo=true"><img src="https://img.shields.io/badge/Live_Demo-Dashboard-FF6B35" alt="Live Demo" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chaehyun2/claudetuner" alt="License" /></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/lang-한국어-blue" alt="Korean" /></a>
</p>

<p align="center">
  Trusted by thousands of Claude, ChatGPT, and Gemini users — from solo Pro subscribers to Enterprise teams worldwide.
</p>

---

<p align="center">
  <img src="docs/screenshots/dashboard-top.png" alt="Dashboard — usage gauges, plan fitness, and weekly trend" width="720" />
</p>

## Why Claude Tuner?

AI rate limits are opaque — you don't know how much you've used, when it resets, or whether your plan is right for you. And most people now juggle more than one AI. Claude Tuner fixes that.

- **See every limit** — live 5h / 7d usage gauges with reset countdowns for Claude, ChatGPT (Codex), and Gemini, all in one popup
- **Claude Code counts too** — claude.ai, the desktop app, and Claude Code all draw from one subscription pool, so your CLI burn shows up in the same gauges. Anthropic exposes that pool as a single number, so it's a combined total, not a per-surface split
- **Predict resets** — know if you'll hit the cap before the window rolls over, with sharpened 7-day projection accuracy
- **Find the right plan** — "what if" simulations across Pro, Max 5x, and Max 20x, with independent 5h / 7d evaluation
- **Monitor your team** — free dashboard covering Claude, ChatGPT & Gemini, with per-member analytics, breach tracking, group comparisons, and access controls for who sees what

## Screenshots

| Usage Trends | Team Dashboard |
|:-:|:-:|
| ![5h/7d usage trend charts](docs/screenshots/dashboard-charts.png) | ![Team overview with race and stats](docs/screenshots/team-overview.png) |

| Insights | Members |
|:-:|:-:|
| ![Global insights — plan & utilization distribution](docs/screenshots/insights.png) | ![Per-member analytics](docs/screenshots/members.png) |

## Features

<details open>
<summary><b>Real-Time Usage Monitoring</b></summary>

- Live 5-hour and 7-day usage gauges — for **Claude, ChatGPT (Codex), and Gemini** side by side
- In-page usage gauge injected right into Claude, ChatGPT, and Gemini — no popup needed
- Reset countdown timers
- Toolbar badge showing current usage level
- 6-tier pace indicator (safe → critical)
- Sparkline charts for usage trends
- Multi-organization & multi-account support (auto-detect or pin, drag to reorder)
</details>

<details open>
<summary><b>Smart Alerts & Predictions</b></summary>

- Usage prediction at reset based on consumption rate — with a redesigned, more accurate 7-day projection (diurnal re-weighting + adaptive smoothing)
- Configurable threshold notifications (80%, 95%)
- Weekly usage reports via email
- Estimated token breakdown per model
- Model-scoped weekly limit tracking (Anthropic rotates which model gets its own weekly bucket)
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

- **Multi-service** — track Claude, ChatGPT, and Gemini usage for the whole team in one dashboard
- **Access controls** — admins decide which members can see whose usage, per member
- Per-member usage analytics and rate limit tracking
- Token usage leaderboard and cost analytics
- Breach tracking with plan upgrade/downgrade recommendations
- Group-based usage comparison analysis
- Daily team reports and weekly personal reports
- Training data policy monitoring
- Domain-based auto-invite and group management (admin)
- Per-organization usage opt-out (hide specific orgs from the shared view)
- CSV / Excel export
</details>

## Supported Plans

Full analytics for every Claude.ai paid plan. ChatGPT (Free / Go / Plus / Pro / Team) and Gemini (Free / AI Plus / Pro / Ultra / Workspace) are also tracked in the popup and dashboard (beta).

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
You ──→ Claude.ai / ChatGPT / Gemini ──→ Claude Tuner extension ──→ Claude Tuner API server
                                            (reads usage data)         (stores history & analytics)
                                                  │
                                                  ▼
                                            Extension popup          Web dashboard
                                           (gauges & alerts)     (charts, team, insights)
```

1. **Collect** — The extension reads the same account usage endpoint claude.ai itself uses, plus ChatGPT and Gemini (no conversation content, ever). Because the Claude subscription pool is shared, this includes usage spent in Claude Code and the desktop app
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
