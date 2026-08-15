import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import * as format from '../src/format.js';
import type { UsageStats, RunSnapshot, RunState } from '../src/types.js';

describe('format helpers', () => {
  it('formats elapsed time', () => {
    const now = Date.now();
    expect(format.formatElapsed(0, now)).toBe('0s');
    expect(format.formatElapsed(now - 30000, now)).toBe('30s');
    expect(format.formatElapsed(now - 125000, now)).toBe('2m5s');
  });

  it('formats tokens compactly', () => {
    expect(format.formatTokens(0)).toBe('0');
    expect(format.formatTokens(500)).toBe('500');
    expect(format.formatTokens(1500)).toBe('1.5k');
    expect(format.formatTokens(2500000)).toBe('2.5M');
  });

  it('formats usage stats', () => {
    const usage: UsageStats = {
      input: 1024,
      output: 512,
      cacheRead: 100,
      cacheWrite: 50,
      cost: 0.0123,
      contextTokens: 8096,
      turns: 3,
    };
    const formatted = format.formatUsage(usage);
    expect(formatted).toContain('3t');
    expect(formatted).toContain('↑1.0k'); // due to toFixed(1)
    expect(formatted).toContain('$0.0123');
  });

  it('formats paths safely', () => {
    expect(format.formatPath(path.join(os.homedir(), 'test/file.txt'))).toContain('~');
    expect(format.formatPath('/very/long/path/that/should/be/truncated/for/display')).toMatch(/^\.\.\./);
  });

  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

  it('renders a one-line call header with width safety', () => {
    const line = format.renderCallLine({ task: 'Implement UI for subagent with parallel support and lots of extra words' }, theme, 60);
    expect(line).toContain('subagent');
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);

    const parallel = format.renderCallLine({ tasks: [{ task: 'a' }, { task: 'b' }] }, theme, 80);
    expect(parallel).toContain('2 parallel tasks');

    const action = format.renderCallLine({ action: 'status', id: 'abcdef1234567890' }, theme, 80);
    expect(action).toContain('status');
    expect(action).toContain('abcdef12');
  });

  it('renders a compact terminal run block', () => {
    const run: format.InlineRunView = {
      mode: 'single',
      state: 'completed' as RunState,
      startedAt: Date.now() - 45000,
      endedAt: Date.now(),
      results: [{
        label: 'task-1',
        state: 'completed' as RunState,
        usage: { turns: 8, input: 20000, output: 13800, cost: 0.012 },
        finalOutput: 'Found 5 middleware call sites\nMore detail here',
        outputFile: '/tmp/out.md',
      }],
    };
    const lines = format.renderRunLines(run, { theme, width: 80 });
    expect(lines[0]).toContain('↻8');
    expect(lines[0]).toContain('tok');
    expect(lines[0]).toContain('45s');
    expect(lines.some((l) => l.includes('Found 5 middleware call sites'))).toBe(true);
    expect(lines.some((l) => l.includes('/tmp/out.md'))).toBe(true);
    expect(lines.every((l) => visibleWidth(l) <= 80)).toBe(true);
  });

  it('renders a fixed-shape streaming block with live activity', () => {
    const run: format.InlineRunView = {
      mode: 'single',
      state: 'running' as RunState,
      startedAt: Date.now() - 8000,
      results: [{ label: 'task-1', state: 'running' as RunState, usage: { turns: 3, input: 10000, output: 2400, cost: 0 }, finalOutput: 'reading src/auth/middleware.ts…' }],
    };
    const lines = format.renderRunLines(run, { theme, width: 80, isPartial: true, spinnerFrame: 2 });
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain(format.SPINNERS[2]);
    expect(lines[1]).toContain('⎿');
    expect(lines[1]).toContain('reading src/auth/middleware.ts');
  });

  it('renders parallel runs one line per task', () => {
    const run: format.InlineRunView = {
      mode: 'parallel',
      state: 'running' as RunState,
      startedAt: Date.now() - 9000,
      results: [
        { label: 't1', state: 'completed' as RunState, usage: { turns: 5, input: 15000, output: 6000, cost: 0.01 }, finalOutput: 'done thing' },
        { label: 't2', state: 'running' as RunState, usage: { turns: 3, input: 9000, output: 3000, cost: 0 }, finalOutput: 'running tests…' },
        { label: 't3', state: 'failed' as RunState, usage: { turns: 1, input: 100, output: 10, cost: 0 }, errorMessage: 'boom' },
      ],
    };
    const lines = format.renderRunLines(run, { theme, width: 100, isPartial: true });
    // completed + failed are both terminal → 2/3 done
    expect(lines[0]).toContain('2/3 done');
    expect(lines.some((l) => l.includes('t1'))).toBe(true);
    expect(lines.some((l) => l.includes('t2') && l.includes('running tests'))).toBe(true);
    expect(lines.some((l) => l.includes('t3') && l.includes('boom'))).toBe(true);
  });

  it('freezes duration at endedAt for finished runs', () => {
    const run: format.InlineRunView = {
      mode: 'single',
      state: 'completed' as RunState,
      startedAt: 1000,
      endedAt: 13_000,
      results: [{ label: 't', state: 'completed' as RunState, usage: { turns: 1, input: 10, output: 10, cost: 0 } }],
    };
    const lines = format.renderRunLines(run, { theme, width: 80, now: 10_000_000 });
    expect(lines[0]).toContain('12s');
  });

  it('status preview is metadata only', () => {
    const snap: RunSnapshot = {
      schemaVersion: 1 as const,
      id: 'abc123456789',
      sessionKey: 'key',
      mode: 'parallel' as const,
      state: 'running' as RunState,
      startedAt: Date.now() - 120000,
      taskPreviews: [],
      delivered: false,
      results: [],
    };
    const preview = format.formatStatusPreview(snap);
    expect(preview).toContain('abc12345');
    expect(preview).toContain('parallel');
    expect(preview).not.toContain('full summary'); // metadata/preview
  });

  it('status preview shows stalled duration for active runs only', () => {
    const now = 1_000_000;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } as UsageStats;
    const base = {
      schemaVersion: 1 as const,
      id: 'runstall1xxxx',
      sessionKey: 'key',
      mode: 'single' as const,
      startedAt: now - 120_000,
      taskPreviews: [] as string[],
      delivered: false,
    };
    const stalledSince = now - 125_000;
    const running: RunSnapshot = {
      ...base,
      state: 'running' as RunState,
      results: [{
        label: 't',
        task: 'x',
        state: 'running' as RunState,
        exitCode: null,
        usage,
        stalledSince,
      }],
    };
    const preview = format.formatStatusPreview(running, now);
    expect(preview).toContain('[stalled 2m5s]');
    expect(preview.split('\n')).toHaveLength(1);

    const finished: RunSnapshot = {
      ...base,
      state: 'failed' as RunState,
      endedAt: now,
      results: [{
        label: 't',
        task: 'x',
        state: 'failed' as RunState,
        exitCode: 1,
        usage,
        stalledSince,
      }],
    };
    expect(format.formatStatusPreview(finished, now)).not.toMatch(/\[stalled /);
  });

  it('status preview shows attempt flag only when attempts > 1', () => {
    const now = 1_000_000;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } as UsageStats;
    const mk = (attempts?: number): RunSnapshot => ({
      schemaVersion: 1 as const,
      id: 'runretry0xxxx',
      sessionKey: 'key',
      mode: 'single' as const,
      state: 'running' as RunState,
      startedAt: now - 30_000,
      taskPreviews: [],
      delivered: false,
      results: [{
        label: 't',
        task: 'x',
        state: 'running' as RunState,
        exitCode: null,
        usage,
        attempts,
      }],
    });
    expect(format.formatStatusPreview(mk(1), now)).not.toMatch(/\[attempt /);
    expect(format.formatStatusPreview(mk(undefined), now)).not.toMatch(/\[attempt /);
    const withRetry = format.formatStatusPreview(mk(2), now);
    expect(withRetry).toContain('[attempt 2]');
    expect(withRetry.split('\n')).toHaveLength(1);
  });

  it('status preview shows waiting age and paused reason', () => {
    const now = 1_000_000;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } as UsageStats;
    const base = {
      schemaVersion: 1 as const,
      id: 'runkeep0xxxx',
      sessionKey: 'key',
      mode: 'single' as const,
      startedAt: now - 120_000,
      taskPreviews: [] as string[],
      delivered: false,
    };
    const waiting: RunSnapshot = {
      ...base,
      state: 'waiting' as RunState,
      results: [{ label: 't', task: 'x', state: 'waiting' as RunState, exitCode: null, usage, waitingSince: now - 90_000 }],
    };
    const waitingPreview = format.formatStatusPreview(waiting, now);
    expect(waitingPreview).toContain('waiting');
    expect(waitingPreview).toContain('[waiting 1m30s]');

    const paused: RunSnapshot = {
      ...base,
      state: 'paused' as RunState,
      endedAt: now,
      results: [{
        label: 't',
        task: 'x',
        state: 'paused' as RunState,
        exitCode: 1,
        usage,
        errorMessage: 'doom-loop watchdog: 3 consecutive wakeups without progress',
      }],
    };
    const pausedPreview = format.formatStatusPreview(paused, now);
    expect(pausedPreview).toContain('paused');
    expect(pausedPreview).toContain('[doom-loop watchdog: 3 consecutive wakeups without progr');
  });

  it('status preview plain case unchanged without reliability flags', () => {
    const snap: RunSnapshot = {
      schemaVersion: 1 as const,
      id: 'plain000xxxx',
      sessionKey: 'key',
      mode: 'parallel' as const,
      state: 'running' as RunState,
      startedAt: 1000,
      taskPreviews: [],
      delivered: false,
      results: [],
    };
    expect(format.formatStatusPreview(snap, 1000 + 45_000)).toBe(
      '[plain000] parallel running 45s ready',
    );
  });
});

describe('statLine', () => {
  const parts = { cost: 0.012, turns: 8, model: 'moonshotai/kimi-k3', tps: 42.4, tokens: 33800, durationMs: 12_000 };

  it('orders cost, model, tps, turns, tokens, duration', () => {
    expect(format.statLine(parts, { live: true })).toBe('$0.012 · kimi-k3 · 42 tps · ↻8 · 34k tok · 12s');
  });

  it('strips the provider prefix from model ids', () => {
    expect(format.shortModelId('moonshotai/kimi-k3')).toBe('kimi-k3');
    expect(format.shortModelId('kimi-k3')).toBe('kimi-k3');
    expect(format.shortModelId(undefined)).toBeUndefined();
  });

  it('shows any positive cost on live rows, keeps the threshold on terminal rows', () => {
    expect(format.statLine({ cost: 0.0004, turns: 1 }, { live: true })).toBe('<$0.001 · ↻1');
    expect(format.statLine({ cost: 0.00004, turns: 1 }, { live: false })).toBe('↻1');
    expect(format.statLine({ cost: 0.0004, turns: 1 }, { live: false })).toBe('<$0.001 · ↻1');
  });

  it('renders ~0 tps for a stalled live run, integer otherwise', () => {
    expect(format.statLine({ tps: 0.2 }, { live: true })).toBe('~0 tps');
    expect(format.statLine({ tps: 0.2 }, { live: false })).toBe('0 tps');
    expect(format.statLine({ tps: 41.6 }, { live: true })).toBe('42 tps');
  });

  it('drops duration, then tokens, then tps under narrow width; cost/turns/model survive', () => {
    const full = format.statLine(parts, { live: true, width: 100 });
    expect(full).toContain('12s');
    const noDuration = format.statLine(parts, { live: true, width: 42 });
    expect(noDuration).not.toContain('12s');
    expect(noDuration).toContain('34k tok');
    const noTokens = format.statLine(parts, { live: true, width: 30 });
    expect(noTokens).not.toContain('tok');
    expect(noTokens).toContain('42 tps');
    const minimal = format.statLine(parts, { live: true, width: 22 });
    expect(minimal).not.toContain('tps');
    expect(minimal).toContain('$0.012');
    expect(minimal).toContain('↻8');
    expect(minimal).toContain('kimi-k3');
  });

  it('finds a shared model for header elision, undefined when mixed', () => {
    expect(format.commonModelId(['moonshotai/kimi-k3', 'kimi-k3'])).toBe('kimi-k3');
    expect(format.commonModelId(['a/x', 'b/y'])).toBeUndefined();
    expect(format.commonModelId([undefined, undefined])).toBeUndefined();
  });
});

describe('computeTps', () => {
  const now = 1_000_000;

  it('uses the rolling window when ≥2 samples fall inside it', () => {
    const samples = [
      { t: now - 20_000, output: 100 },
      { t: now - 10_000, output: 520 },
    ];
    expect(format.computeTps({ output: 520, samples, startedAt: now - 90_000, now, live: true })).toBeCloseTo(42);
  });

  it('falls back to lifetime output/elapsed with fewer than 2 recent samples', () => {
    const stale = [
      { t: now - 50_000, output: 100 },
      { t: now - 40_000, output: 520 },
    ];
    expect(format.computeTps({ output: 900, samples: stale, startedAt: now - 30_000, now, live: true })).toBeCloseTo(30);
    expect(format.computeTps({ output: 900, samples: [{ t: now - 5_000, output: 900 }], startedAt: now - 30_000, now, live: true })).toBeCloseTo(30);
  });

  it('uses the lifetime average for terminal runs, freezing at endedAt', () => {
    const samples = [
      { t: now - 20_000, output: 100 },
      { t: now - 10_000, output: 520 },
    ];
    expect(format.computeTps({ output: 600, samples, startedAt: now - 60_000, endedAt: now - 30_000, now, live: false })).toBeCloseTo(20);
  });
});

describe('composeRunFailureMessage', () => {
  it('leads with the per-task failure reason, not the delivered pointer', () => {
    const message = format.composeRunFailureMessage(
      {
        state: 'failed',
        summary: '[task-1] failed\nOutput written to /tmp/x.md',
        results: [{ label: 'task-1', state: 'failed', errorMessage: 'Subagent exited with code 1' }],
      },
      'Output written to /tmp/x.md',
    );
    expect(message).toContain('Subagent run failed.');
    expect(message).toContain('[task-1] failed: Subagent exited with code 1');
    expect(message).toContain('Output written to /tmp/x.md');
    expect(message.indexOf('exited with code 1')).toBeLessThan(message.indexOf('Output written to /tmp/x.md'));
  });

  it('names the reason when output is empty', () => {
    const message = format.composeRunFailureMessage(
      { state: 'failed', results: [{ label: 'worker', state: 'failed', errorMessage: 'model exploded' }] },
      '(no output)',
    );
    expect(message).toContain('[worker] failed: model exploded');
    expect(message).not.toContain('(no output)');
  });

  it('falls back to the run summary when no task carries an errorMessage', () => {
    const message = format.composeRunFailureMessage(
      { state: 'lost', summary: '[task-1] lost\npartial answer', results: [{ label: 'task-1', state: 'lost' }] },
      'partial answer',
    );
    expect(message).toContain('Subagent run lost.');
    expect(message).toContain('[task-1] lost partial answer');
  });

  it('does not repeat the delivered text when it is the summary', () => {
    const summary = '[task-1] failed\nOutput written to /tmp/x.md';
    const message = format.composeRunFailureMessage({ state: 'failed', summary, results: [] }, summary);
    expect(message.match(/Output written to \/tmp\/x\.md/g)).toHaveLength(1);
  });

  it('still names the state when nothing else is known', () => {
    expect(format.composeRunFailureMessage({ state: 'failed' }, '(no output)')).toBe('Subagent run failed.');
  });
});
