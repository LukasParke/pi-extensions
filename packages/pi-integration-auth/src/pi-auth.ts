import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { piAgentDir } from "@parke.dev/pi-ext-config";

export interface ApiKeyCredential {
	type: "api_key";
	key: string;
	label?: string;
}

export type Credential = ApiKeyCredential;
export type AuthFile = Record<string, Credential>;

export function integrationAuthPath() {
	return join(piAgentDir(), "integration-auth.json");
}

export class PiAuthStore {
	readonly kind = "file" as const;

	constructor(private readonly path = integrationAuthPath()) {}

	describe() {
		return `${this.path} (file, 0600 — readable by any process running as you)`;
	}

	private read(): AuthFile {
		if (!existsSync(this.path)) return {};
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			return parsed as AuthFile;
		} catch {
			return {};
		}
	}

	private write(data: AuthFile) {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp-${process.pid}`;
		writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.path);
	}

	async set(ref: string, value: string) {
		await this.setCredential(ref, { type: "api_key", key: value });
	}

	async get(ref: string) {
		const credential = this.read()[ref];
		return credential?.key.trim() || null;
	}

	async delete(ref: string) {
		const data = this.read();
		if (!(ref in data)) return;
		delete data[ref];
		if (Object.keys(data).length === 0) {
			try {
				unlinkSync(this.path);
			} catch {}
			return;
		}
		this.write(data);
	}

	async setCredential(ref: string, credential: Credential) {
		if (!credential.key.trim()) throw new Error("refusing to store an empty credential");
		const data = this.read();
		data[ref] = { ...credential, key: credential.key.trim() };
		this.write(data);
	}

	async getCredential(ref: string) {
		return this.read()[ref] ?? null;
	}

	async list() {
		return Object.keys(this.read()).sort();
	}
}
