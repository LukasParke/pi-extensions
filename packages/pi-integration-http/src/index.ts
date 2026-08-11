export * from "./cache.ts";
export * from "./client.ts";
export * from "./error.ts";
export * from "./limiter.ts";

export interface RateProfile {
	capacity: number;
	refillPerSec: number;
}

export const RATE_PROFILES: Readonly<Record<string, RateProfile>> = {
	git: { capacity: 20, refillPerSec: 10 },
	linear: { capacity: 10, refillPerSec: 0.4 },
	slack: { capacity: 10, refillPerSec: 0.8 },
	notion: { capacity: 6, refillPerSec: 2.5 },
	github: { capacity: 15, refillPerSec: 1.2 },
};

export function rateProfileFor(provider: string): RateProfile {
	return RATE_PROFILES[provider] ?? { capacity: 5, refillPerSec: 1 };
}
