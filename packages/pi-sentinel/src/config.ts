import { boolean, load, type Schema } from "@parke.dev/pi-ext-config";

export interface SentinelConfig {
	cmuxStatus: boolean;
}

export const defaults: SentinelConfig = { cmuxStatus: false };
export const schema: Schema<SentinelConfig> = {
	cmuxStatus: { validate: boolean, env: "PI_SENTINEL_CMUX_STATUS" },
};

export async function sentinelConfig() {
	return (await load({ name: "sentinel", schema, defaults })).config;
}
