"use strict";

/**
 * Workflow sandbox child.
 *
 * Launched by lib/workflow-sandbox.ts under Node permission mode with no
 * filesystem, network or child-process access. It receives model-authored
 * orchestration source over an authenticated IPC channel and runs it inside a
 * `vm` context whose global object has a null prototype and no host bindings.
 *
 * Defence in depth, in order of importance:
 *  1. Node `--permission` denies fs/net/spawn at the runtime level.
 *  2. The `vm` context exposes only agent/parallel/phase/args; `codeGeneration`
 *     is disabled so eval and new Function cannot be used to reach out.
 *  3. `process` bridges to builtins/native bindings/signalling are nulled
 *     before any workflow source is compiled, so a future V8 context escape
 *     still finds no convenient path to the host.
 *  4. The parent validates every IPC message against a random per-run token.
 *
 * Adapted from davis7dotsh/my-pi-setup's workflows extension; the sandbox
 * design is theirs, the agent execution path is ours (see workflow-sandbox.ts).
 */

const vm = require("node:vm");

const sendIpc = typeof process.send === "function" ? process.send.bind(process) : undefined;

// Remove convenient bridges before compiling anything untrusted.
for (const capability of [
	"getBuiltinModule",
	"binding",
	"_linkedBinding",
	"dlopen",
	"kill",
	"abort",
	"send",
]) {
	try {
		Object.defineProperty(process, capability, { value: undefined, writable: false, configurable: false });
	} catch {
		// Permission mode and the VM boundary remain the mandatory controls.
	}
}

const BOOTSTRAP = String.raw`
(function bootstrapWorkflowApi() {
  "use strict";
  const callHost = globalThis.__hostBridge;
  delete globalThis.__hostBridge;
  let nextRequestId = 0;
  const unconsumed = new Set();
  const inFlight = new Set();

  function deepFreeze(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 32 || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1);
    return value;
  }

  /**
   * agent() returns a lazy thenable: the request is only sent when awaited.
   * That lets us detect a workflow that created calls it never awaited, which
   * is almost always a bug (and would otherwise leak a running child).
   */
  function requestAgent(promptValue, optionsValue = {}) {
    const id = ++nextRequestId;
    unconsumed.add(id);
    let started;
    const begin = () => {
      unconsumed.delete(id);
      if (!started) {
        let payload;
        try {
          payload = JSON.stringify({
            id,
            prompt: typeof promptValue === "string" ? promptValue : String(promptValue ?? ""),
            options: optionsValue && typeof optionsValue === "object" ? optionsValue : {},
          });
        } catch (error) {
          started = Promise.reject(new Error("agent() arguments must be serializable: " + error.message));
          return started;
        }
        inFlight.add(id);
        started = callHost("agent", payload)
          .then((json) => JSON.parse(json))
          .finally(() => inFlight.delete(id));
      }
      return started;
    };
    return Object.freeze({
      then(resolve, reject) { return begin().then(resolve, reject); },
      catch(reject) { return begin().catch(reject); },
      finally(callback) { return begin().finally(callback); },
      get [Symbol.toStringTag]() { return "Promise"; },
    });
  }

  async function mapLimited(items, concurrency, invoke) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await invoke(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function parallel(items, options = {}) {
    if (!Array.isArray(items)) throw new Error("parallel() expects an array of zero-argument agent thunks");
    const requested = options && typeof options.concurrency === "number" ? Math.floor(options.concurrency) : 4;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("parallel(): concurrency must be a positive integer");
    }
    const concurrency = Math.min(__MAX_CONCURRENCY__, requested);
    return mapLimited(items, concurrency, (item) => {
      if (typeof item !== "function") throw new Error("parallel() items must be zero-argument functions");
      return item();
    });
  }

  /**
   * Map over a dynamically discovered collection with bounded concurrency.
   * Sugar over the same limiter parallel() uses — dominant dynamic-workflow shape.
   */
  async function pipeline(items, mapper, options = {}) {
    if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items");
    if (typeof mapper !== "function") throw new Error("pipeline() expects a mapper function");
    const requested = options && typeof options.concurrency === "number" ? Math.floor(options.concurrency) : 4;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("pipeline(): concurrency must be a positive integer");
    }
    const concurrency = Math.min(__MAX_CONCURRENCY__, requested);
    return mapLimited(items, concurrency, (item) => mapper(item));
  }

  function phase(title) {
    callHost("phase", JSON.stringify({ title: String(title) }));
  }

  const argsEnvelope = JSON.parse(globalThis.__argsJson);
  const args = argsEnvelope.defined ? deepFreeze(argsEnvelope.value) : undefined;
  delete globalThis.__argsJson;

  const stringify = JSON.stringify;
  function serializeResult(value) {
    const seen = new WeakSet();
    return stringify(value === undefined ? null : value, (_key, item) => {
      if (typeof item === "bigint") return item.toString() + "n";
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  }

  Object.defineProperties(globalThis, {
    agent: { value: requestAgent, writable: false, configurable: false },
    parallel: { value: parallel, writable: false, configurable: false },
    pipeline: { value: pipeline, writable: false, configurable: false },
    phase: { value: phase, writable: false, configurable: false },
    args: { value: args, writable: false, configurable: false },
    __workflowCheck: {
      value: Object.freeze(() => ({ unconsumed: unconsumed.size, inFlight: inFlight.size })),
      writable: false, configurable: false,
    },
    __workflowSerialize: { value: Object.freeze(serializeResult), writable: false, configurable: false },
  });
})();
`;

let initialized = false;
let token;
const pendingAgents = new Map();

function send(message) {
	sendIpc?.({ token, ...message });
}

function fail(error) {
	const message = error instanceof Error ? error.message : String(error);
	send({ kind: "error", error: message.slice(0, 16 * 1024) });
}

process.on("message", (message) => {
	if (!message || typeof message !== "object") return;
	if (!initialized) {
		if (
			message.kind !== "init" ||
			typeof message.token !== "string" ||
			typeof message.source !== "string" ||
			typeof message.argsJson !== "string"
		) {
			process.exitCode = 1;
			return;
		}
		initialized = true;
		token = message.token;
		run(message.source, message.argsJson, message.maxConcurrency);
		return;
	}
	if (message.token !== token || message.kind !== "agentResult") return;
	const pending = pendingAgents.get(message.id);
	if (!pending) return;
	pendingAgents.delete(message.id);
	if (typeof message.resultJson === "string") pending.resolve(message.resultJson);
	else pending.reject(new Error(typeof message.error === "string" ? message.error : "Agent IPC failed"));
});

function run(source, argsJson, maxConcurrency) {
	try {
		const sandbox = Object.create(null);
		sandbox.__argsJson = argsJson;
		sandbox.__hostBridge = (kind, payloadJson) => {
			if (kind === "phase") {
				send({ kind: "phase", payloadJson });
				return undefined;
			}
			if (kind !== "agent") return Promise.reject(new Error("Unknown workflow operation"));
			let id;
			try {
				id = JSON.parse(payloadJson).id;
			} catch {
				return Promise.reject(new Error("Invalid agent request"));
			}
			return new Promise((resolve, reject) => {
				pendingAgents.set(id, { resolve, reject });
				send({ kind: "agent", payloadJson });
			});
		};

		const context = vm.createContext(sandbox, {
			name: "pi-workflow",
			// No eval / new Function / wasm: the script cannot synthesize code.
			codeGeneration: { strings: false, wasm: false },
		});
		const bootstrap = BOOTSTRAP.replaceAll(
			"__MAX_CONCURRENCY__",
			String(Number.isSafeInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 4),
		);
		new vm.Script(bootstrap, { filename: "workflow-bootstrap.js" }).runInContext(context, { timeout: 1000 });

		const workflow = vm.compileFunction(
			`"use strict";\nreturn (async function workflow() {\n${source}\n})();`,
			["agent", "parallel", "pipeline", "phase", "args"],
			{ filename: "workflow-script.js", parsingContext: context },
		);
		context.__workflowBody = workflow;

		// Run the body, then assert the workflow did not leave agent calls
		// dangling: an unawaited call means a child we would never collect.
		const invoke = `
      (() => {
        const workflowBody = globalThis.__workflowBody;
        delete globalThis.__workflowBody;
        globalThis.__workflowPromise = Promise.resolve(
          workflowBody(agent, parallel, pipeline, phase, args),
        ).then(async (value) => {
          await Promise.resolve();
          const pending = __workflowCheck();
          if (pending.unconsumed > 0) {
            throw new Error("Workflow created " + pending.unconsumed + " unawaited agent() call(s)");
          }
          if (pending.inFlight > 0) {
            throw new Error("Workflow returned before " + pending.inFlight + " agent call(s) settled");
          }
          return __workflowSerialize(value);
        });
      })();
    `;
		new vm.Script(invoke, { filename: "workflow-invoke.js" }).runInContext(context, { timeout: 1000 });

		Promise.resolve(context.__workflowPromise)
			.then((resultJson) => {
				if (typeof resultJson !== "string") throw new Error("Workflow result was not serializable");
				send({ kind: "result", resultJson });
			})
			.catch(fail);
	} catch (error) {
		fail(error);
	}
}
