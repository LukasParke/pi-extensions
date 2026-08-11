import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { PiAuthStore } from "./pi-auth.ts";

export interface CredentialSetup {
	id: string;
	label: string;
	authRef: string;
	envNames: readonly string[];
	prompt: string;
	validate: (token: string) => Promise<string>;
	store: PiAuthStore;
}

async function secretInput(ctx: ExtensionCommandContext, title: string) {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(undefined);
		return {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render(width: number) {
				return [
					truncateToWidth(theme.fg("accent", theme.bold(title)), width),
					...input.render(width).map(() => theme.fg("muted", "•".repeat(input.getValue().length))),
					truncateToWidth(theme.fg("dim", "Enter save · Esc cancel · input is hidden"), width),
				];
			},
			handleInput(data: string) {
				input.handleInput(data);
				tui.requestRender();
			},
			invalidate() {
				input.invalidate();
			},
		};
	});
}

export function registerCredentialCommand(pi: ExtensionAPI, setup: CredentialSetup) {
	pi.registerCommand(setup.id, {
		description: `Configure ${setup.label} authentication`,
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(
					`/${setup.id} requires an interactive Pi terminal. Alternatively set ${setup.envNames.map((name) => `$${name}`).join(" or ")}.`,
					"error",
				);
				return;
			}
			const token = (await secretInput(ctx, setup.prompt))?.trim();
			if (!token) {
				ctx.ui.notify(`${setup.label} setup cancelled.`, "info");
				return;
			}
			try {
				const account = await setup.validate(token);
				await setup.store.setCredential(setup.authRef, {
					type: "api_key",
					key: token,
					label: account,
				});
				ctx.ui.notify(`${setup.label} connected as ${account}.`, "info");
			} catch (error) {
				ctx.ui.notify(
					`${setup.label} rejected the credential: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
