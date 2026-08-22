# Synthesis Tray

Synthesis Tray is a desktop-only Obsidian plugin for manually composing an explicit request from selected authored Markdown and a local conversation. The plugin never decides what vault context is relevant: there is no autonomous retrieval, RAG, indexing, ranking, link/embed expansion, summarization, or silent truncation.

## Product contract

- The user explicitly adds selections, headings, notes, folders, or conversation snapshots to one shared active tray.
- Each completed turn stores immutable source snapshots. Historical snapshots are distinct from the current vault note.
- Visible conversation history contains the user messages and assistant responses. The current tray is supplied only to the next request.
- The tray is shared across threads; model and reasoning settings are thread-scoped.

## Setup and controls

```text
npm install
npm test
npm run build
```

Copy `dist/` into `<vault>/.obsidian/plugins/obsidian-synthesis-tray/`, enable the plugin, and reload Obsidian after rebuilding.

Store an OpenAI API key in Obsidian SecretStorage, then select its secret name in settings. Configure the editable system prompt, the Responses API verbosity (`Low`, `Medium`, or `High`), maximum output tokens, and prompt caching. Verbosity is sent as `text.verbosity`; it is not prompt prose or thread provenance.

Each thread independently selects one of `Sol`, `Terra`, or `Luna` and a reasoning effort of `None`, `Low`, `Medium`, `High`, `Extra High`, or `Max`. Genuinely new threads default to **Luna · High**. Existing thread and completed-turn provenance is not rewritten.

## Tray UX

The tray displays newest-first while canonical source identifiers remain stable in insertion order. Folder captures remain grouped, can be collapsed or resized, and use deterministic initial expansion: small groups may open and large groups start collapsed. An explicit user collapse or expansion survives unrelated tray mutations. The approximate local `o200k_base` token estimate is shown by system, conversation, tray, and current-message buckets; stable buckets are cached until their inputs change. Previous successful trays can be recalled without rereading notes.

## Citations and snapshots

Sources are serialized with identifiers such as `[S1]`. Localized claims should use snapshot-relative citations such as `[S1:L42-L48]`; the line numbers refer to the numbered immutable snapshot supplied to that turn, not to current or original vault-file line numbers. Historical source inspection opens that stored snapshot. A current-note view, when available, is a separate operation.

## Usage metadata

Completed turns may show the actual model and reasoning effort, input tokens, output tokens, cached input usage, and reasoning tokens within the output total. For example: `Luna · High · 84,210 input · 6,420 output (4,812 reasoning)`. Reasoning tokens are a subset of output tokens, not an additional total. Raw provider usage is retained locally.

## Referencing assistant text

Select text within one completed assistant response, open its native context menu, and choose **Reference in next message**. The plugin inserts a visible Markdown quote into the composer. It is ordinary user message content, remains visible after a failed or aborted request, can be edited or removed before sending, and is cleared with the draft after a successful send. It is not hidden context and does not mutate the historical assistant response.

## Security and privacy

The API key value is obtained from Obsidian SecretStorage. Only the configured secret identifier is persisted by the plugin. On Send, the configured instructions, visible prior conversation, selected tray snapshots, current user message (including an explicit assistant reference), and request parameters are sent to OpenAI. See [SECURITY.md](SECURITY.md) for the complete boundary.

The local SQLite database can contain sensitive authored content: conversations, active and previous tray snapshots, historical source snapshots, and provider usage/provenance. Protecting the vault and plugin directory therefore protects Synthesis Tray history. Synthesis Tray is read-only with respect to authored vault files. The project does not add product telemetry; OpenAI API requests are request traffic, not plugin telemetry.

## Current limitations

- Desktop only; Reading View selection is not supported.
- No external live web search yet. Synthesis Tray currently sends explicit authored context only.
- No autonomous retrieval/RAG, branching, editing, or regeneration of prior turns.
- No images, PDFs, attachments, or background requests.

## License

Synthesis Tray is licensed under the [Apache License 2.0](LICENSE). Dependency licenses remain the responsibility of their respective projects.
