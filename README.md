# LongChat Perf · Task Vital Monitor

A Chromium extension for long ChatGPT conversations and long-running tasks. Version **0.5.2** combines the original LongChat Perf rendering optimizations with request throttling, task-liveness diagnostics, conversation-chain verification, final-message persistence checks, and optional DevHub integration.

## Download

GitHub Releases include a ready-to-unzip extension archive (`longchat-perf-v0.5.2.zip`) plus its SHA-256 file. Unzip it, then load the extracted folder from `chrome://extensions` or `edge://extensions` with Developer Mode enabled.

The packaging workflow runs tests, stages only runtime files, creates the ZIP, uploads a GitHub Actions artifact, and attaches the ZIP to a published GitHub Release.

## Performance patches

The original LongChat Perf functionality remains available: off-screen `content-visibility`, optional backdrop-filter disabling, progressive old-message folding, streaming-phase animation throttling, CodeMirror batch mounting, and local main-thread long-task statistics. Messages containing tables remain excluded from `content-visibility` to avoid wide-table clipping.

Existing project measurements reported cumulative long-task time improving from 41.4s to 20.0s and worst single freeze from 8.5s to 1.1s across several code-heavy conversations. These are project measurements, not a universal guarantee.

## Task liveness

The extension correlates passive `/stream_status`, bounded independent probes, resume results, general backend reachability, final assistant-message persistence, and optional DevHub liveness. A backend `COMPLETE` state is not treated as success until the final assistant message is observed in the conversation.

## Request guard

Conversation-list and conversation-detail GETs use cross-tab coordination, caching, a minimum real-request interval, and 429 backoff. `stream_status` is intentionally preserved as a health signal rather than aggressively cached away.

## DevHub

Optional project routing can map ChatGPT project/conversation names to DevHub project/slot identities. Tokens stay in session storage by default and are never placed in Chrome Sync.

## Development

```bash
npm ci
npm test
npm run package:stage
```

## Privacy

This combined version is no longer a strictly local-only rendering patch: liveness features observe and coordinate ChatGPT backend traffic, and optional DevHub integration performs explicit requests to the configured DevHub origin. There is no third-party analytics or telemetry. See [PRIVACY.md](PRIVACY.md).

## License

MIT.
