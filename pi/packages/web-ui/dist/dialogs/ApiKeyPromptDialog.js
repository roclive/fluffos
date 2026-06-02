var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { customElement, state } from "lit/decorators.js";
import "../components/ProviderKeyInput.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { getAppStorage } from "../storage/app-storage.js";
import { i18n } from "../utils/i18n.js";
let ApiKeyPromptDialog = class ApiKeyPromptDialog extends DialogBase {
    provider = "";
    resolvePromise;
    unsubscribe;
    modalWidth = "min(500px, 90vw)";
    modalHeight = "auto";
    static async prompt(provider) {
        const dialog = new ApiKeyPromptDialog();
        dialog.provider = provider;
        dialog.open();
        return new Promise((resolve) => {
            dialog.resolvePromise = resolve;
        });
    }
    async connectedCallback() {
        super.connectedCallback();
        // Poll for key existence - when key is added, resolve and close
        const checkInterval = setInterval(async () => {
            const hasKey = !!(await getAppStorage().providerKeys.get(this.provider));
            if (hasKey) {
                clearInterval(checkInterval);
                if (this.resolvePromise) {
                    this.resolvePromise(true);
                    this.resolvePromise = undefined;
                }
                this.close();
            }
        }, 500);
        this.unsubscribe = () => clearInterval(checkInterval);
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
    }
    close() {
        super.close();
        if (this.resolvePromise) {
            this.resolvePromise(false);
        }
    }
    renderContent() {
        return html `
			${DialogContent({
            children: html `
					${DialogHeader({
                title: i18n("API Key Required"),
            })}
					<provider-key-input .provider=${this.provider}></provider-key-input>
				`,
        })}
		`;
    }
};
__decorate([
    state()
], ApiKeyPromptDialog.prototype, "provider", void 0);
ApiKeyPromptDialog = __decorate([
    customElement("api-key-prompt-dialog")
], ApiKeyPromptDialog);
export { ApiKeyPromptDialog };
//# sourceMappingURL=ApiKeyPromptDialog.js.map