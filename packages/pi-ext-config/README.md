# @parke.dev/pi-ext-config

Shared typed configuration loader for [pi coding agent](https://pi.dev) extensions.

Every extension needs the same thing: typed settings that resolve
**defaults ← config file ← environment**, tolerate a malformed file, and never let a
bad value through. This is that, once.

It is a library, not an extension — it registers no tools and no skills.

## Install

```bash
npm install @parke.dev/pi-ext-config
```

Do not `pi install` this package — other extensions depend on it and call
`load()` from their own config modules.

## Why

An extension that hardcodes a hostname or an API key is unusable by anyone but its
author, and one that throws on a config typo is worse than one with no config at all.
This package exists so each extension gets both properties for free.

## Usage

Declare a schema alongside your config interface, then load it:

```ts
import { httpUrl, load, nonEmptyString, number, type Schema } from "@parke.dev/pi-ext-config";

export interface MyConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

const defaults: MyConfig = {
  baseUrl: "http://localhost:3000",
  timeoutMs: 30_000,
};

const schema: Schema<MyConfig> = {
  baseUrl: { validate: httpUrl, env: "MY_BASE_URL" },
  apiKey: { validate: nonEmptyString, env: "MY_API_KEY" },
  timeoutMs: { validate: number(1_000), env: "MY_TIMEOUT_MS" },
};

// Reads ~/.pi/mytool.json, layers env over it, fills gaps from defaults.
const { config, file } = await load({ name: "mytool", schema, defaults });
```

Memoize it if tools will call it repeatedly:

```ts
let cached: Promise<MyConfig> | undefined;
export function myConfig(): Promise<MyConfig> {
  cached ??= load({ name: "mytool", schema, defaults }).then((r) => r.config);
  return cached;
}
```

## Validators

| Validator            | Accepts                                                       |
| -------------------- | ------------------------------------------------------------- |
| `nonEmptyString`     | a non-blank string, trimmed                                   |
| `httpUrl`            | an absolute `http:`/`https:` URL, trailing slashes stripped   |
| `number(min?, max?)` | a finite number in range; coerces numeric strings from env    |
| `boolean`            | `true`/`false`, or the strings `"true"`/`"false"`/`"1"`/`"0"` |
| `oneOf([...])`       | one of an allowed string set                                  |
| `filePath`           | an absolute or `~`-relative path, resolved                    |
| `stringArray`        | an array of non-empty strings                                 |

Write your own by matching `Validator<T> = (value: unknown) => T | undefined`.

## Design decisions

**Validators return `undefined` instead of throwing.** A user with a typo in one field
gets the default for that field and a working extension, rather than an extension that
fails to load. Silent degradation is the right trade for optional config; a hard failure
punishes the user for a harmless mistake.

**Env wins over file.** The file is the durable preference, env is the per-shell
override. This matches pi's own precedence.

**Unknown keys are dropped.** Only keys present in the schema survive `sanitize`, so a
stale field from an old version cannot leak through as `undefined` and clobber a default.

**Absent keys are not written as `undefined`.** `sanitize` skips keys missing from the
input entirely, which is what makes the three-layer merge safe.

**Config lives beside pi's agent dir, not a hardcoded `~/.pi`.** The path derives from
`piConfigDir()`, which honours `PI_CODING_AGENT_DIR` and a rebranded `configDir`.

## API

| Export                                                   | Purpose                                              |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `load({ name, schema, defaults, configDirName?, env? })` | the whole pipeline; returns `{ config, file }`       |
| `resolve(schema, defaults, fileOverrides?, env?)`        | pure three-layer merge, for tests                    |
| `readFile(schema, file)`                                 | read + sanitize one file; `{}` on missing or invalid |
| `sanitize(schema, raw)`                                  | keep only recognized, valid keys                     |
| `fromEnv(schema, env?)`                                  | read only the env vars the schema names              |
| `piAgentDir(configDirName?)`                             | e.g. `~/.pi/agent`; honors `PI_CODING_AGENT_DIR`     |
| `piConfigDir(configDirName?)`                            | e.g. `~/.pi`                                         |
| `configFilePath(name, configDirName?)`                   | e.g. `~/.pi/steel.json`                              |
| `expandTilde(path)`                                      | `~/x` → `/home/you/x`                                |
| `describeEnv(schema)`                                    | `{ field, env }[]`, for generating README tables     |

## License

MIT
