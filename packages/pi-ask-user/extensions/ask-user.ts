/**
 * `ask_user` — let the model ask one multiple-choice question.
 *
 * Useful when a request is genuinely ambiguous and guessing wastes a whole turn
 * (which library, which of three files did you mean, migrate or rewrite). The
 * model gets a real answer instead of picking one and being wrong.
 *
 * Deliberate differences from the reference implementation:
 *
 * - It builds a bespoke `ctx.ui.custom` component (~300 lines of arrow-key and
 *   inline-Editor handling) and hard-refuses when `ctx.mode !== "tui"`. We use
 *   `ctx.ui.select` plus `ctx.ui.input`, which are the SDK's own dialogs, work
 *   in RPC mode as well as the TUI, and are far less code to get wrong.
 * - We guard on `ctx.hasUI` rather than `mode === "tui"` so RPC sessions (which
 *   *are* dialog-capable) still get to answer.
 *
 * Every call appends a "let me type my own answer" option, and a dismissal is
 * reported honestly so the model does not invent an answer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withBlockedSignal } from "./blocked.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const CUSTOM_LABEL = "Let me type my own answer…";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one multiple-choice question when the right course of action is genuinely ambiguous and guessing would waste work. Provide 2-5 concrete options; a free-text option is always added, and the user may dismiss without answering. Ask exactly one question per call, and prefer proceeding on your own judgement when the stakes are low.",
		parameters: Type.Object(
			{
				question: Type.String({
					minLength: 1,
					description: "The single question to ask. Keep it short and concrete.",
				}),
				options: Type.Array(
					Type.Object(
						{
							label: Type.String({ minLength: 1, description: "Short option text." }),
							description: Type.Optional(
								Type.String({ description: "Optional clarifying detail for this option." }),
							),
						},
						{ additionalProperties: false },
					),
					{
						minItems: MIN_OPTIONS,
						maxItems: MAX_OPTIONS,
						description: `${MIN_OPTIONS}-${MAX_OPTIONS} distinct options. A free-text option is appended automatically.`,
					},
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: any, signal, _onUpdate, ctx) {
			const options: Array<{ label: string; description?: string }> = params.options;

			// No dialog-capable UI (print mode, JSON mode): say so plainly instead
			// of blocking forever or pretending the user declined.
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Cannot ask the user: this session has no interactive UI. Decide using your own judgement, state the assumption you made, and continue.",
						},
					],
					details: { question: params.question, answer: null, outcome: "no-ui" },
				};
			}
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "The question was cancelled before it was shown." }],
					details: { question: params.question, answer: null, outcome: "cancelled" },
				};
			}

			// Render descriptions inline: ctx.ui.select takes plain strings, and the
			// detail is often what makes an option meaningful.
			const labels = options.map((option) =>
				option.description ? `${option.label} — ${option.description}` : option.label,
			);
			const blockedLabel = params.question.length > 80 ? `${params.question.slice(0, 79)}…` : params.question;
			const choice = await withBlockedSignal(pi, blockedLabel, () =>
				ctx.ui.select(params.question, [...labels, CUSTOM_LABEL], { signal }),
			);

			// Dismissed (Esc): the model must not assume an answer.
			if (choice === undefined || choice === null) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The user dismissed the question without answering. Do not assume an answer — either proceed and clearly state the assumption you are making, or ask a different question.",
						},
					],
					details: { question: params.question, answer: null, outcome: "dismissed" },
				};
			}

			if (choice === CUSTOM_LABEL) {
				const typed = (
					await withBlockedSignal(pi, blockedLabel, () =>
						ctx.ui.input(params.question, "Type your answer…", { signal }),
					)
				)?.trim();
				if (!typed) {
					return {
						content: [
							{
								type: "text" as const,
								text: "The user chose to write their own answer but submitted nothing. Treat this as no answer given.",
							},
						],
						details: { question: params.question, answer: null, outcome: "empty-custom" },
					};
				}
				return {
					content: [{ type: "text" as const, text: `The user answered (free text): ${typed}` }],
					details: { question: params.question, answer: typed, outcome: "custom" },
				};
			}

			// Map the rendered label back to the option the model supplied, so the
			// answer it sees is its own wording rather than our display string.
			const index = labels.indexOf(choice);
			const picked = index >= 0 ? options[index]! : undefined;
			const answer = picked?.label ?? choice;
			return {
				content: [{ type: "text" as const, text: `The user chose: ${answer}` }],
				details: { question: params.question, answer, outcome: "selected", index },
			};
		},
	});
}
