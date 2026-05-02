# Contributing to Claude Tuner

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Fork and clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repository folder
5. Visit [claude.ai](https://claude.ai) to start collecting usage data

There is no build step — the source files are loaded directly by Chrome.

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Test the extension locally (reload from `chrome://extensions/`)
4. Submit a pull request

### Guidelines

- Keep changes focused — one feature or fix per PR
- Follow existing code style (no build tools, no transpilation)
- Test with both English and Korean locales
- Update `_locales/` if adding user-facing strings

### What happens to accepted PRs

This repository is a **read-only mirror** of the extension source from a private monorepo. When a PR is accepted:

1. The changes are cherry-picked into the private monorepo
2. The next release syncs back to this repo
3. Your contribution is included in the Chrome Web Store update

This means your PR branch won't be directly merged — but you'll see your changes appear in a subsequent commit with attribution.

## Bug Reports

Please [open an issue](https://github.com/chaehyun2/claudetuner/issues) with:

- Extension version (shown in popup footer or `chrome://extensions/`)
- Chrome version
- Steps to reproduce
- Expected vs actual behavior

## Feature Requests

Feature requests are welcome! Open an issue with the **enhancement** label.

## Code of Conduct

Be respectful and constructive. We're all here to make Claude usage tracking better.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
