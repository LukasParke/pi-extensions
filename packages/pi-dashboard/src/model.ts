/**
 * Live model / context / tok-s tracking.
 *
 * tok/s measures content streamed *after* the first delta over the interval
 * from first to last delta — the first chunk is not treated as instant work.
 */

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;

export interface ModelSnapshot {
	provider: string;
	modelId: string;
	thinking: string;
	contextPercent: number | null;
	contextWindow: number;
	tokensPerSecond: number | null;
	generating: boolean;
}

export function emptyModelSnapshot(): ModelSnapshot {
	return {
		provider: "",
		modelId: "no-model",
		thinking: "off",
		contextPercent: null,
		contextWindow: 0,
		tokensPerSecond: null,
		generating: false,
	};
}

export function estimateContentTokens(characters: number) {
	return Math.ceil(Math.max(0, characters) / CHARS_PER_ESTIMATED_TOKEN);
}

export interface StreamTracker {
	onContentDelta(delta: string, now?: number): number | null;
	onToolCall(): void;
	/** Finalize after an assistant message; returns the run-averaged tok/s or null. */
	endMessage(options?: { outputTokens?: number; now?: number }): number | null;
	resetMessage(): void;
	resetRun(): void;
	readonly tokensPerSecond: number | null;
}

export function createStreamTracker(): StreamTracker {
	let contentStreamStart: number | null = null;
	let lastContentDeltaAt: number | null = null;
	let contentCharacters = 0;
	let firstContentDeltaCharacters = 0;
	let contentDeltaCount = 0;
	let sawToolCall = false;
	let lastLiveUpdate = 0;
	let runContentTokens = 0;
	let runContentStreamMs = 0;
	let tokensPerSecond: number | null = null;

	function resetMessage() {
		contentStreamStart = null;
		lastContentDeltaAt = null;
		contentCharacters = 0;
		firstContentDeltaCharacters = 0;
		contentDeltaCount = 0;
		sawToolCall = false;
		lastLiveUpdate = 0;
	}

	function resetRun() {
		resetMessage();
		runContentTokens = 0;
		runContentStreamMs = 0;
		tokensPerSecond = null;
	}

	return {
		get tokensPerSecond() {
			return tokensPerSecond;
		},
		resetMessage,
		resetRun,
		onToolCall() {
			sawToolCall = true;
		},
		onContentDelta(delta, now = Date.now()) {
			if (!delta) return tokensPerSecond;

			if (contentStreamStart === null) {
				contentStreamStart = now;
				firstContentDeltaCharacters = delta.length;
			}
			lastContentDeltaAt = now;
			contentCharacters += delta.length;
			contentDeltaCount += 1;

			const elapsedMs = now - contentStreamStart;
			const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
			if (
				contentDeltaCount < 2 ||
				elapsedMs <= 0 ||
				streamedCharacters <= 0 ||
				now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
			) {
				return tokensPerSecond;
			}
			lastLiveUpdate = now;
			tokensPerSecond = estimateContentTokens(streamedCharacters) / (elapsedMs / 1000);
			return tokensPerSecond;
		},
		endMessage(options = {}) {
			if (contentStreamStart !== null && contentCharacters > 0) {
				const streamEnd = lastContentDeltaAt ?? contentStreamStart;
				const streamMs = Math.max(0, streamEnd - contentStreamStart);
				const estimatedFirst = estimateContentTokens(firstContentDeltaCharacters);
				const streamedTokens =
					!sawToolCall && options.outputTokens !== undefined && options.outputTokens > 0
						? Math.max(0, options.outputTokens - estimatedFirst)
						: Math.max(0, estimateContentTokens(contentCharacters) - estimatedFirst);

				if (contentDeltaCount >= 2 && streamMs >= 50 && streamedTokens > 0) {
					runContentTokens += streamedTokens;
					runContentStreamMs += streamMs;
					tokensPerSecond = runContentTokens / (runContentStreamMs / 1000);
				}
			}
			resetMessage();
			return tokensPerSecond;
		},
	};
}

export function formatModelLabel(snapshot: ModelSnapshot) {
	if (!snapshot.provider && snapshot.modelId === "no-model") return "no model";
	const base = snapshot.provider ? `${snapshot.provider}/${snapshot.modelId}` : snapshot.modelId;
	if (!snapshot.thinking || snapshot.thinking === "off") return base;
	return `${base} · ${snapshot.thinking}`;
}
