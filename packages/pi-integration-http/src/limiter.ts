export interface BucketOptions {
	capacity: number;
	refillPerSec: number;
	now?: () => number;
}

export interface AcquireResult {
	waited: number;
}

export class TokenBucket {
	private tokens: number;
	private lastRefill: number;
	private readonly now: () => number;
	private readonly waiters: { resolve: () => void; cost: number }[] = [];
	private draining = false;

	constructor(private readonly opts: BucketOptions) {
		this.now = opts.now ?? Date.now;
		this.tokens = opts.capacity;
		this.lastRefill = this.now();
	}

	available(): number {
		this.refill();
		return this.tokens;
	}

	queueDepth(): number {
		return this.waiters.length;
	}

	private refill(): void {
		const t = this.now();
		const elapsedSec = (t - this.lastRefill) / 1000;
		if (elapsedSec <= 0) return;
		this.tokens = Math.min(this.opts.capacity, this.tokens + elapsedSec * this.opts.refillPerSec);
		this.lastRefill = t;
	}

	async acquire(cost = 1): Promise<AcquireResult> {
		const started = this.now();
		this.refill();

		if (this.waiters.length === 0 && this.tokens >= cost) {
			this.tokens -= cost;
			return { waited: 0 };
		}

		await new Promise<void>((resolve) => {
			this.waiters.push({ resolve, cost });
			void this.drain();
		});
		return { waited: Math.max(0, this.now() - started) };
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.waiters.length > 0) {
				this.refill();
				const head = this.waiters[0] as { resolve: () => void; cost: number };
				if (this.tokens >= head.cost) {
					this.tokens -= head.cost;
					this.waiters.shift();
					head.resolve();
					continue;
				}
				const deficit = head.cost - this.tokens;
				const waitMs = Math.ceil((deficit / this.opts.refillPerSec) * 1000);
				await new Promise((r) => setTimeout(r, Math.max(1, Math.min(waitMs, 5_000))));
			}
		} finally {
			this.draining = false;
		}
	}
}

/* --------------------------- circuit breaker --------------------------- */

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
	threshold: number;
	openMs: number;
	now?: () => number;
}

export class CircuitBreaker {
	private state: BreakerState = "closed";
	private failures = 0;
	private openedAt = 0;
	private probeInFlight = false;
	private readonly now: () => number;

	constructor(private readonly opts: BreakerOptions) {
		this.now = opts.now ?? Date.now;
	}

	current(): BreakerState {
		if (this.state === "open" && this.now() - this.openedAt >= this.opts.openMs) {
			this.state = "half_open";
			this.probeInFlight = false;
		}
		return this.state;
	}

	allows(): boolean {
		const s = this.current();
		if (s === "closed") return true;
		if (s === "open") return false;
		if (this.probeInFlight) return false;
		this.probeInFlight = true;
		return true;
	}

	onSuccess(): void {
		this.state = "closed";
		this.failures = 0;
		this.probeInFlight = false;
	}

	onFailure(): void {
		if (this.current() === "half_open") {
			this.open();
			return;
		}
		this.failures++;
		if (this.failures >= this.opts.threshold) this.open();
	}

	private open(): void {
		this.state = "open";
		this.openedAt = this.now();
		this.probeInFlight = false;
	}

	failureCount(): number {
		return this.failures;
	}
}
