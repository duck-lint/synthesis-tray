# Security and privacy

## Boundary

Synthesis Tray is a desktop-only Obsidian plugin. It is read-only with respect to authored vault files and does not autonomously search, retrieve, index, rank, follow links, expand embeds, or select vault context. The user controls the active tray.

## API key

The API key value is obtained from Obsidian SecretStorage for a request. Synthesis Tray persists only the configured SecretStorage identifier/name; it does not persist the resolved secret value in plugin settings, SQLite, logs, or conversation records. The key is transmitted only to the OpenAI API for the request.

## Data sent externally

When the user presses Send, the request sent to OpenAI contains the configured system instructions, visible prior conversation, the currently selected tray snapshots, the current user message (including any visibly inserted assistant-text reference), and request parameters such as model, reasoning effort, maximum output tokens, verbosity, and prompt-caching controls. A completed response is streamed back from the OpenAI Responses API.

## Local persistence

The plugin directory contains a SQLite database that can include sensitive authored content, including:

- visible conversations;
- active and previous tray snapshots;
- immutable historical source snapshots;
- model, reasoning, source provenance, and provider usage data.

Protect the vault and its `.obsidian/plugins/obsidian-synthesis-tray/` directory as you would protect the authored material itself. The database is not metadata-only.

## Telemetry

The repository contains no separate product telemetry implementation. OpenAI API requests are necessary request traffic for the configured synthesis operation and should not be confused with telemetry.

## Vulnerability reporting

Do not post API keys, vault content, database files, or other secrets in a public issue. Use GitHub's private security-advisory reporting flow for this repository when available. If that flow is unavailable, contact the repository maintainers through an authenticated GitHub channel and provide only a minimal reproduction with secrets removed.
