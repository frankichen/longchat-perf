# Privacy

LongChat Perf · Task Vital Monitor has no analytics, advertising, or third-party telemetry.

## ChatGPT data

The extension runs only on ChatGPT pages. It may observe/intercept ChatGPT's own conversation-list, conversation-detail, stream-status, resume, project metadata, and usage responses in order to reduce duplicate requests and diagnose task health. Conversation response snapshots used for request coalescing are kept in `chrome.storage.session` and are not uploaded to any third party.

The performance module reads DOM structure, message identifiers, geometry, scroll position, DOM mutations, and CodeMirror mounting behavior. It does not intentionally export message text.

## DevHub

DevHub integration is optional. When enabled, the extension may submit compact browser-side activity evidence such as conversation id, health state, project/slot routing, timestamps, and diagnostic metadata to the configured DevHub origin. It does not intentionally submit full ChatGPT message bodies.

DevHub bearer tokens are stored in `chrome.storage.session` by default. If the user explicitly chooses persistent storage, the token is stored in `chrome.storage.local`. Tokens are never stored in `chrome.storage.sync`.

## Settings

Non-secret extension settings may be stored in `chrome.storage.sync` or `chrome.storage.local`. The configuration export page clearly distinguishes ordinary exports from exports that include persistently stored secrets.
