import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { renderCallLine, renderRunLines, stateTone, oneLine, statLine } from '../src/format.js';
import { SubagentsOverlay, type SubagentAdapter } from '../src/ui.js';
import type { RunSnapshot, RunState } from '../src/types.js';

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as Theme;
const run = (id: string, state: RunState, delivered = false): RunSnapshot => ({
  schemaVersion: 1, id, sessionKey: 'test', mode: 'single', state, delivered,
  startedAt: 1000, endedAt: state === 'running' ? undefined : 13_000,
  taskPreviews: ['Long prompt that should not displace the label'], summary: 'Summary first',
  results: [{ label: `Audit ${id}`, task: 'task', state, exitCode: 0,
    model: 'provider/model', usage: { input: 1000, output: 100, cost: 0.01, turns: 8, cacheRead: 0, cacheWrite: 0, contextTokens: 0 },
    finalOutput: 'Findings\nNext steps', transcript: 'PRIVATE TRANSCRIPT',
    errorMessage: state === 'failed' ? 'Provider unavailable' : undefined,
  }],
});
const overlays: SubagentsOverlay[] = [];
afterEach(() => { overlays.splice(0).forEach((overlay) => overlay.dispose()); vi.useRealTimers(); });

function inspector(initial: RunSnapshot[], rows = 24) {
  let runs = initial;
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const adapter: SubagentAdapter = {
    getActiveRuns: () => runs.filter((r) => ['running', 'waiting', 'queued'].includes(r.state)),
    getCompletedRuns: () => runs.filter((r) => !['running', 'waiting', 'queued'].includes(r.state)),
    getRunById: (id) => runs.find((r) => r.id === id) ?? null,
    getReadyCount: () => runs.filter((r) => !r.delivered && !['running', 'waiting', 'queued'].includes(r.state)).length,
    cancelRun: vi.fn(), steerRun: vi.fn(), dismissRun: vi.fn(), resumeRun: vi.fn(), showOutput: vi.fn(),
    applyWorktree: vi.fn(), discardWorktree: vi.fn(),
    subscribe: (fn) => { listener = fn; return unsubscribe; },
  };
  const terminal = { rows };
  const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
  const done = vi.fn();
  const overlay = new SubagentsOverlay(tui, theme, done, adapter);
  overlays.push(overlay);
  return { overlay, adapter, tui, terminal, done, unsubscribe, update: (next: RunSnapshot[]) => { runs = next; listener?.(); } };
}

describe('native-width presentation contract', () => {
  it.each([12, 60, 80, 120])('snapshots collapsed/expanded/partial/failure/parallel at %i columns', (width) => {
    const variants = [
      { name: 'done', run: run('done', 'completed'), expanded: false },
      { name: 'expanded', run: run('done', 'completed'), expanded: true },
      { name: 'starting', run: { ...run('live', 'running'), results: [{ ...run('live', 'running').results[0]!, finalOutput: '' }] }, expanded: false },
      { name: 'partial', run: run('partial', 'partial'), expanded: false },
      { name: 'failed', run: run('failed', 'failed'), expanded: false },
      { name: 'waiting', run: run('waiting', 'waiting'), expanded: false },
      { name: 'timeout', run: run('timeout', 'timeout'), expanded: false },
      { name: 'cancelled', run: run('cancelled', 'cancelled'), expanded: false },
      { name: 'wrapped', run: { ...run('wrapped', 'partial'), results: [{ ...run('wrapped', 'partial').results[0]!, wrappedUp: true, stopReason: 'max_turns' }] }, expanded: false },
      { name: 'parallel', run: { ...run('parallel', 'running'), mode: 'parallel' as const, results: [run('one', 'completed').results[0]!, run('two', 'running').results[0]!, run('three', 'failed').results[0]!] }, expanded: false },
    ];
    const output = Object.fromEntries(variants.map(({ name, run: value, expanded }) => [name, renderRunLines(value, { theme, width, expanded, now: 13_000 })]));
    for (const lines of Object.values(output)) expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(output.starting).toHaveLength(2);
    expect(output.done.join('\n')).not.toMatch(/tok|↻|\$/);
    expect(output).toMatchSnapshot();
  });

  it.each([12, 60, 80, 120])('snapshots inspector groups and summary at %i columns', (width) => {
    vi.useFakeTimers();
    vi.setSystemTime(13_000);
    const { overlay } = inspector([run('live', 'running'), run('ready', 'completed'), run('old', 'failed', true)], 24);
    const list = overlay.render(width);
    overlay.handleInput('j');
    overlay.handleInput('\r');
    const detail = overlay.render(width);
    expect([...list, ...detail].every((line) => visibleWidth(line) <= width)).toBe(true);
    expect({ list, detail }).toMatchSnapshot();
  });

  it('uses label-first calls, strips child control sequences, and preserves wide text', () => {
    const input = '\x1b]0;fake title\x07\x1b[31m日本語\x1b[0m\x07\u202e label';
    expect(oneLine(input, 8)).toBe('日本語 …');
    for (const width of [1, 8, 12, 60, 80, 120]) {
      const line = renderCallLine({ task: 'giant prompt', description: input }, theme, width);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toMatch(/fake title|giant prompt|\x1b\[31m|\x1b\]|\x07|\u202e/);
      const lines = renderRunLines({ ...run('wide', 'completed'), results: [{ ...run('wide', 'completed').results[0]!, label: input, model: input, finalOutput: input, outputFile: input, sessionId: input, worktree: { cwd: '/tmp', branch: input } }] }, { theme, width, expanded: true });
      expect(lines.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(lines.join('\n')).not.toMatch(/\x1b\[31m|\x1b\]|\x07|\u202e/);
    }
    expect(visibleWidth(statLine({ model: '日本語', cost: 0.01, tokens: 1000 }, { width: 15 }))).toBeLessThanOrEqual(15);
  });

  it('bounds expanded output and collapsed fanout with explicit overflow', () => {
    const task = { ...run('many', 'completed').results[0]!, finalOutput: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'), outputFile: '/tmp/report.md' };
    const expanded = renderRunLines({ mode: 'single', state: 'completed', results: [task] }, { theme, width: 60, expanded: true });
    expect(expanded.join('\n')).toContain('+20 lines');
    expect(expanded.join('\n')).toContain('/tmp/report.md');
    const parallel = renderRunLines({ mode: 'parallel', state: 'running', results: Array.from({ length: 8 }, () => ({ ...task, state: 'running' as const })) }, { theme, width: 60 });
    expect(parallel).toHaveLength(14);
    expect(parallel.at(-1)).toContain('+2 tasks');
  });

  it('keeps expanded active results fixed at two rows as output accumulates', () => {
    for (const count of [1, 10, 80]) {
      const value = run('live', 'running');
      value.results[0]!.finalOutput = Array.from({ length: count }, (_, index) => `activity ${index}`).join('\n');
      const lines = renderRunLines(value, { theme, width: 80, expanded: true, now: 13_000 });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`activity ${count - 1}`);
    }
  });

  it('uses semantic state tones including warning waits and muted cancellations', () => {
    expect(['running', 'completed', 'waiting', 'partial', 'timeout', 'failed', 'cancelled'].map((s) => stateTone(s as RunState))).toEqual(['accent', 'success', 'warning', 'warning', 'warning', 'error', 'muted']);
  });
});

describe('inspector viewport and keys', () => {
  it('groups active/ready/history, with summary-first details and on-demand transcripts', () => {
    const { overlay } = inspector([run('old', 'completed', true), run('live', 'running'), run('ready', 'completed')], 40);
    const list = overlay.render(80).join('\n');
    expect(list.indexOf('Active')).toBeLessThan(list.indexOf('Ready'));
    expect(list.indexOf('Ready')).toBeLessThan(list.indexOf('History'));
    overlay.handleInput('j');
    overlay.handleInput('\r');
    const detail = overlay.render(80).join('\n');
    expect(detail.indexOf('Summary first')).toBeLessThan(detail.indexOf('Findings'));
    expect(detail).not.toContain('PRIVATE TRANSCRIPT');
    overlay.handleInput('t');
    expect(overlay.render(80).join('\n')).toContain('PRIVATE TRANSCRIPT');
    overlay.handleInput('t');
    expect(overlay.render(80).join('\n')).not.toContain('PRIVATE TRANSCRIPT');
  });

  it.each([10, 24, 50])('keeps large history selectable within %i terminal rows and follows resize', (rows) => {
    const runs = Array.from({ length: 100 }, (_, i) => run(String(i).padStart(3, '0'), 'completed', true));
    const { overlay, adapter, terminal, update } = inspector(runs, rows);
    for (let i = 0; i < 90; i++) overlay.handleInput('j');
    expect(overlay.render(60).join('\n')).toContain('Audit 090');
    expect(overlay.render(60).length).toBeLessThanOrEqual(Math.floor(rows * 0.8));
    update([run('new', 'running'), ...runs.slice().reverse()]);
    overlay.handleInput('o');
    expect(adapter.showOutput).toHaveBeenLastCalledWith('090');
    expect(overlay.render(60).join('\n')).toContain('Audit 090');
    terminal.rows = 12;
    expect(overlay.render(12).length).toBeLessThanOrEqual(9);
    update([run('only', 'completed')]);
    overlay.handleInput('o');
    expect(adapter.showOutput).toHaveBeenLastCalledWith('only');
  });

  it.each([5, 6, 7])('prioritizes the selected title in a %i-row terminal', (rows) => {
    const { overlay } = inspector([run('tiny', 'completed')], rows);
    const lines = overlay.render(80);
    expect(lines.join('\n')).toContain('Audit tiny');
    expect(lines.join('\n')).toContain('›');
  });

  it('preserves state-aware cancel/steer/resume/output/apply/discard and idempotent close/disposal', () => {
    vi.useFakeTimers();
    const active = run('live', 'running');
    const { overlay, adapter, update, done, unsubscribe, tui } = inspector([active]);
    overlay.handleInput('c'); overlay.handleInput('s'); overlay.handleInput('o');
    expect(adapter.cancelRun).toHaveBeenCalledWith('live');
    expect(adapter.steerRun).toHaveBeenCalledWith('live');
    expect(adapter.showOutput).toHaveBeenCalledWith('live');
    overlay.handleInput('r');
    expect(adapter.resumeRun).not.toHaveBeenCalled();
    const finished = run('live', 'completed');
    finished.results[0]!.worktree = { cwd: '/tmp/wt', branch: 'agent/test', baseCommit: 'abc', changed: true };
    update([finished]);
    overlay.handleInput('r'); overlay.handleInput('a'); overlay.handleInput('x'); overlay.handleInput('d');
    expect(adapter.resumeRun).toHaveBeenCalledWith('live');
    expect(adapter.applyWorktree).toHaveBeenCalledWith('live');
    expect(adapter.discardWorktree).toHaveBeenCalledWith('live');
    expect(adapter.dismissRun).toHaveBeenCalledWith('live');
    overlay.handleInput('\r'); overlay.handleInput('\x1b');
    expect(done).not.toHaveBeenCalled();
    overlay.handleInput('\x1b'); overlay.close(); overlay.dispose();
    expect(done).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const renders = vi.mocked(tui.requestRender).mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(tui.requestRender).toHaveBeenCalledTimes(renders);
    expect(overlay.render(80)).toEqual([]);
  });

  it('scrolls detail by the current viewport and stops live transcript polling on back', () => {
    vi.useFakeTimers();
    const active = run('live', 'running');
    active.summary = Array.from({ length: 100 }, (_, i) => `summary ${i}`).join('\n');
    const { overlay, tui, adapter } = inspector([active], 20);
    overlay.handleInput('\r');
    expect(overlay.render(80).join('\n')).toContain('summary 0');
    overlay.handleInput('\x1b[6~');
    expect(overlay.render(80).join('\n')).not.toContain('summary 0\n');
    overlay.handleInput('\x1b[5~');
    expect(overlay.render(80).join('\n')).toContain('summary 0');
    overlay.handleInput('t');
    expect(overlay.render(80).join('\n')).toContain('waiting for child session');
    overlay.handleInput('s');
    expect(adapter.steerRun).toHaveBeenCalledWith('live');
    overlay.handleInput('\x1b');
    const renders = vi.mocked(tui.requestRender).mock.calls.length;
    vi.advanceTimersByTime(500);
    // The active-run animation remains; the transcript's 500ms poll is gone.
    expect(tui.requestRender).toHaveBeenCalledTimes(renders + 5);
    overlay.dispose();
    const disposedRenders = vi.mocked(tui.requestRender).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(tui.requestRender).toHaveBeenCalledTimes(disposedRenders);
  });

  it('re-evaluates theme tones after native invalidation', () => {
    const { overlay } = inspector([run('ready', 'completed')]);
    const oldFg = theme.fg;
    try {
      theme.fg = ((_tone: string, text: string) => `\x1b[31m${text}\x1b[0m`) as Theme['fg'];
      expect(overlay.render(80).join('\n')).toContain('\x1b[31m');
      theme.fg = ((_tone: string, text: string) => `\x1b[32m${text}\x1b[0m`) as Theme['fg'];
      overlay.invalidate();
      const next = overlay.render(80).join('\n');
      expect(next).toContain('\x1b[32m');
      expect(next).not.toContain('\x1b[31m');
    } finally { theme.fg = oldFg; }
  });
});
