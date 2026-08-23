import { App, Modal } from "obsidian";
import { LinkedContextComparison, TrayComparison, trayItemLabel } from "./trayComparison";

function boundedList(container: HTMLElement, title: string, items: string[], sign: string): void {
  if (items.length === 0) return;
  const details = container.createEl("details", { cls: "synthesis-recall-section" });
  details.createEl("summary", { text: `${title} · ${items.length}` });
  const visible = items.slice(0, 8);
  for (const item of visible) details.createDiv({ text: `${sign} ${item}`, cls: "synthesis-recall-item" });
  if (items.length > visible.length) details.createDiv({ text: `… ${items.length - visible.length} more`, cls: "synthesis-tray-scope" });
}

export function confirmRecallWithComparison(app: App, comparison: TrayComparison, linked: LinkedContextComparison): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      modal.close();
    };
    const modal = new class extends Modal {
      override onOpen(): void {
        this.setTitle("Recall previous tray");
        this.contentEl.createEl("p", { text: "The previous tray will replace the current tray. Review the deterministic snapshot differences before recalling it." });
        boundedList(this.contentEl, "Would add from previous", comparison.added.map(trayItemLabel), "+");
        boundedList(this.contentEl, "Would remove from current", comparison.removed.map(trayItemLabel), "−");
        this.contentEl.createDiv({ text: `Unchanged · ${comparison.unchanged.length}`, cls: "synthesis-recall-unchanged" });
        if (linked.added.length || linked.removed.length) {
          if (linked.added.length) {
            this.contentEl.createDiv({ text: `Linked context restored · ${linked.addedDestinations.length} destination${linked.addedDestinations.length === 1 ? "" : "s"} across ${linked.added.length} provenance edge${linked.added.length === 1 ? "" : "s"}`, cls: "synthesis-recall-linked" });
          }
          if (linked.removed.length) this.contentEl.createDiv({ text: `Linked edges removed from current · ${linked.removed.length}`, cls: "synthesis-tray-scope" });
        } else if (linked.unchanged.length) {
          this.contentEl.createDiv({ text: `Linked context unchanged · ${linked.unchanged.length} provenance edge${linked.unchanged.length === 1 ? "" : "s"}`, cls: "synthesis-recall-linked" });
        }
        const actions = this.contentEl.createDiv("synthesis-modal-actions");
        actions.createEl("button", { text: "Cancel" }).onclick = () => finish(false);
        actions.createEl("button", { text: "Recall previous", cls: "mod-cta" }).onclick = () => finish(true);
      }

      override onClose(): void {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }
    }(app);
    modal.open();
  });
}
