# @parke.dev/pi-file-links

Makes local file paths clickable in normal user and assistant Markdown in Pi's interactive transcript.

The extension uses Pi's display-only `registerMarkdownTransformer` hook and its existing Markdown/OSC 8 renderer. Persisted messages, model context, and tool result payloads are unchanged.

## Install

```bash
pi install npm:@parke.dev/pi-file-links
```

Restart Pi after installing.

## Supported paths

- Absolute: `/Users/luke/project/src/index.ts:12:4`
- Home-relative: `~/project/README.md`
- Explicit relative: `./src/index.ts` and `../package.json`
- Conservative repo-relative: `src/index.ts` and `packages/app/package.json`
- Paths containing spaces when quoted: `"./docs/release notes.md"`

Optional `:line` and `:line:column` suffixes remain visible but are not included in the `file://` destination. Paths are resolved against the active session working directory, and URL characters are encoded with Node's `pathToFileURL`.

The transformer leaves code blocks, inline code, existing Markdown links and images, URLs, and non-path prose alone. It performs no filesystem scans or `stat` calls and also runs safely on partial streaming text. When Pi detects that the terminal does not support hyperlinks, it returns the Markdown unchanged to avoid displaying fallback URLs.

Pi already links built-in file-tool titles. Pi does not expose a generic display-only transformer for arbitrary tool-result rows, so this package deliberately does not override tools or modify their LLM-visible results.

## License

MIT
