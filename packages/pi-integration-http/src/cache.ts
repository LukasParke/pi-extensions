export interface CacheEntry<T> {
	value: T;
	at: number;
	stale: boolean;
	reason: string | null;
}

export interface CacheOptions {
	ttlMs: number;
	maxEntries?: number;
	now?: () => number;
}

export const DEFAULT_CACHE_TTL_MS = 30_000;
export const DEFAULT_MAX_ENTRIES = 500;

export function cacheKey(bindingId: string, segment: string, discriminator?: string): string {
	const enc = (s: string) => encodeURIComponent(s);
	return discriminator === undefined
		? `${enc(bindingId)}/${enc(segment)}`
		: `${enc(bindingId)}/${enc(segment)}/${enc(discriminator)}`;
}

export class TtlCache {
	private readonly map = new Map<string, { value: unknown; at: number; ttlMs: number }>();
	private readonly now: () => number;

	constructor(private readonly opts: CacheOptions) {
		this.now = opts.now ?? Date.now;
	}

	size(): number {
		return this.map.size;
	}

	get<T>(key: string): CacheEntry<T> | null {
		const hit = this.map.get(key);
		if (hit === undefined) return null;

		this.map.delete(key);
		this.map.set(key, hit);

		const age = this.now() - hit.at;
		const stale = age > hit.ttlMs;
		return {
			value: hit.value as T,
			at: hit.at,
			stale,
			reason: stale ? `not refreshed for ${Math.round(age / 1000)}s` : null,
		};
	}

	set<T>(key: string, value: T, ttlMs?: number): void {
		this.map.set(key, { value, at: this.now(), ttlMs: ttlMs ?? this.opts.ttlMs });
		this.evictIfNeeded();
	}

	invalidate(key: string): boolean {
		const hit = this.map.get(key);
		if (hit === undefined) return false;
		this.map.set(key, { ...hit, at: 0 });
		return true;
	}

	invalidateSegment(bindingId: string, segment: string): number {
		const prefix = cacheKey(bindingId, segment);
		let n = 0;
		for (const key of this.map.keys()) {
			if (key === prefix || key.startsWith(`${prefix}/`)) {
				this.invalidate(key);
				n++;
			}
		}
		return n;
	}

	dropBinding(bindingId: string): number {
		const prefix = `${encodeURIComponent(bindingId)}/`;
		let n = 0;
		for (const key of [...this.map.keys()]) {
			if (key.startsWith(prefix)) {
				this.map.delete(key);
				n++;
			}
		}
		return n;
	}

	clear(): void {
		this.map.clear();
	}

	private evictIfNeeded(): void {
		const max = this.opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
		while (this.map.size > max) {
			const oldest = this.map.keys().next();
			if (oldest.done === true) break;
			this.map.delete(oldest.value);
		}
	}
}
