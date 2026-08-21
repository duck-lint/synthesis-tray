import { App, Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { PluginSettings } from "./state/types";
import { mergeSettings } from "./state/settings";

export class SynthesisSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SynthesisPluginLike & Plugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Synthesis Tray" });

    const secretSetting = new Setting(containerEl)
      .setName("OpenAI secret")
      .setDesc("Select a secret already stored by Obsidian. The resolved value is never stored by this plugin.");
    new SecretComponent(this.app, secretSetting.controlEl)
      .setValue(this.plugin.settings.secretName)
      .onChange(async (value) => {
        this.plugin.settings.secretName = value;
        await this.plugin.saveSettings();
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("The model identifier sent to the Responses API.")
      .addText((text) => text.setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("The complete editable synthesis instruction.")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.systemPrompt)
        .onChange(async (value) => {
          this.plugin.settings.systemPrompt = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Maximum output tokens")
      .setDesc("Informational request limit; the plugin does not truncate input context.")
      .addText((text) => text
        .setValue(String(this.plugin.settings.maxOutputTokens))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed) && parsed > 0) {
            this.plugin.settings.maxOutputTokens = parsed;
            await this.plugin.saveSettings();
          }
        }));
  }
}

export interface SynthesisPluginLike {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
}

export { mergeSettings } from "./state/settings";
