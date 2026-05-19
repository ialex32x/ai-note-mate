import { App } from "obsidian";

export function getAppSecret(app: App, secret: string) {
    return app.secretStorage.getSecret(secret) ?? "";
}
