# Synthesis Tray

Synthesis Tray is a desktop-only Obsidian plugin for manually composing selected authored Markdown with a local conversation and sending that explicit context to OpenAI's Responses API.

It does not search, index, rank, retrieve, follow links, expand embeds, summarize, or truncate vault content. The tray is the user's explicit selection boundary.

## Development

```text
npm install
npm test
npm run build
```

Copy the contents of `dist/` into `<vault>/.obsidian/plugins/obsidian-synthesis-tray/`, enable the plugin, and reload Obsidian after rebuilding. The build has no dependency on any other local project.

## Setup and use

1. Store an OpenAI API key in Obsidian's Secrets / Keychain feature.
2. Open the plugin settings and select the stored secret name. The secret value is read only while a request is constructed and is never placed in plugin data, SQLite, logs, or conversation records.
3. Set the editable system prompt and maximum output tokens in plugin settings. Model tier and reasoning effort are selected per synthesis thread in the pane: Sol, Terra, or Luna, with None, Low, Medium, High, Extra High, or Max reasoning effort. New threads default to Sol with None effort.
4. Open the **Synthesis Tray** side pane from the command palette.
5. In Markdown source mode or Live Preview, use the editor context menu or command palette to add an exact selection, the heading under the cursor, or the current note. The file explorer context menu can add a whole note or recursively add a folder's Markdown notes.
6. Write a message and press **Send**. A request is built from the editable system prompt, the active thread's model and reasoning effort, visible prior messages, the current tray only, and the current message.

The approximate token count is local `o200k_base` tokenization of those text components. It is informational and never causes silent context removal.

## Persistence and lifecycle

Threads, visible messages, turns, per-turn inference provenance, provider usage, per-turn source snapshots, the active tray, the previous successful tray, and active thread identity are stored in `conversations.sqlite3` inside the installed plugin directory. The database is a standard SQLite file produced by the packaged sql.js WASM runtime. Conversation history stores only visible user messages and assistant responses; source serialization is not copied into historical user messages. Existing thread records receive deterministic Sol and None defaults when opened for the first time after this amendment. The former `gpt-5.6` setting migrates to the canonical `gpt-5.6-sol` thread configuration.

The active tray survives pane close, plugin reload, and Obsidian restart. It is shared across synthesis threads; switching threads does not implicitly change it. A successful completed response stores that turn's immutable source snapshots as the previous tray and clears the active tray. Failure, malformed responses, and Stop preserve it. **Recall previous tray** restores snapshots without rereading notes and asks before replacing a populated tray.

The tray is displayed newest-first for large-tray usability, while source identifiers and request serialization retain canonical insertion order. Folder captures are displayed as explicit expandable groups, but each Markdown note remains an individual source.

Historical assistant turns expose the exact immutable source snapshots supplied to that turn. Citation line numbers such as `[S1:L42-L48]` refer to lines in that captured snapshot, not necessarily to original vault-file coordinates. The current note can be opened separately where a corresponding Markdown file exists.

Thread deletion is confirmed and removes only plugin-owned data for that thread. It never edits the vault or deletes secrets.

## V1 limitations

- Desktop only; Reading View selection is not supported.
- No editing or regeneration of prior turns, branching, images, PDFs, attachments, or background requests. Historical source citations can open the immutable supplied snapshot; current-note opening remains explicitly separate.
- Source content is sent only after the user presses Send and only for the current tray.
- The plugin is read-only with respect to authored vault files and does not create notes or hidden vault artifacts.
