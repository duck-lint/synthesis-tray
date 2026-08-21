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
2. Open the plugin settings and select the stored secret name. The secret value is read only while a request is constructed and is never placed in plugin data, IndexedDB, logs, or conversation records.
3. Set the model, editable system prompt, and maximum output tokens.
4. Open the **Synthesis Tray** side pane from the command palette.
5. In Markdown source mode or Live Preview, use the editor context menu or command palette to add an exact selection, the heading under the cursor, or the current note. The file explorer context menu can add a whole note.
6. Write a message and press **Send**. A request is built from the editable system prompt, visible prior messages, the current tray only, and the current message.

The approximate token count is local `o200k_base` tokenization of those text components. It is informational and never causes silent context removal.

## Persistence and lifecycle

Threads, visible messages, turns, per-turn source snapshots, the active tray, the previous successful tray, and active thread identity are stored in a plugin/vault-namespaced IndexedDB database. Conversation history stores only visible user messages and assistant responses; source serialization is not copied into historical user messages.

The active tray survives pane close, plugin reload, and Obsidian restart. A successful completed response stores that turn's immutable source snapshots as the previous tray and clears the active tray. Failure, malformed responses, and Stop preserve it. **Recall previous tray** restores snapshots without rereading notes and asks before replacing a populated tray.

Thread deletion is confirmed and removes only plugin-owned data for that thread. It never edits the vault or deletes secrets.

## V1 limitations

- Desktop only; Reading View selection is not supported.
- No editing or regeneration of prior turns, branching, click-through source references, images, PDFs, attachments, telemetry, or background requests.
- Source content is sent only after the user presses Send and only for the current tray.
- The plugin is read-only with respect to authored vault files and does not create notes or hidden vault artifacts.
