import { load, dump } from 'js-yaml';
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { executionContext } from '../server/git.js';
const fixture = realpathSync(await mkdtemp(join(tmpdir(), 'hooks-browser-')));
const evidence = resolve('test-results/browser-smoke');
await mkdir(evidence, { recursive: true });
const projects = [join(fixture, 'checkout-a'), join(fixture, 'checkout-b')];
const events = [['SessionStart', 'Session start'], ['UserPromptSubmit', 'User prompt'], ['PreToolUse', 'Before tool use'], ['PostToolUse', 'After tool use'], ['Stop', 'Stop']] as const;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'ignore' });
for (const [index, path] of projects.entries()) {
    await cp(resolve('examples/demo'), path, { recursive: true });
    git(path, 'init', '-b', index === 0 ? 'main' : 'feature/search');
    git(path, 'config', 'user.name', 'Fixture');
    git(path, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, 'fixture-file'), 'fixture');
    git(path, 'add', 'fixture-file');
    git(path, 'commit', '-m', 'Fixture');
    git(path, 'remote', 'add', 'origin', index === 0 ? 'git@github.com:example/app.git' : 'https://github.com/example/app.git');
    const file = join(path, '.codex/hooks/registry.yaml');
    const original = load(await readFile(file, 'utf8')) as {
        hooks: Record<string, unknown>[];
    };
    const template = original.hooks[0];
    await writeFile(file, dump({ managementVersion: 1, events: events.map(([id, label]) => ({ id, label, description: 'Fixture' })), hooks: events.map(([event], i) => ({ ...template, id: 'stage-' + event, event, order: 10, label: i === 1 ? 'A longer stage title that wraps on a narrow screen and retains its status row' : 'Check ' + event, managed: { enabled: true, blocking: template.canBlock === true, dependsOn: [] } })) }));
    await mkdir(join(path, '.claude'), { recursive: true });
    await writeFile(join(path, '.claude/settings.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(([event]) => [event, [{ hooks: [{ type: 'command', command: 'node fixture-check.cjs' }] }]])) }));
    const context = executionContext(path, { cwd: path });
    const ledger = join(path, '.codex/hooks/state/event-ledger');
    await mkdir(ledger, { recursive: true });
    const rows = (['codex', 'claude'] as const).flatMap((provider, i) => ['started', 'completed'].map(kind => ({ schemaVersion: 2, at: new Date(Date.now() - i * 1000).toISOString(), provider, invocationId: `invocation-${index}-${provider}`, hookName: 'dispatcher', hookEventName: 'Stop', sessionId: provider === 'codex' ? 'shared-session' : `claude-${index}`, kind, decision: kind === 'completed' ? 'passed' : 'started', context })));
    rows.push({ schemaVersion: 2, at: new Date().toISOString(), provider: 'claude', invocationId: `invocation-${index}-claude`, hookName: 'stage-Stop', hookEventName: 'Stop', sessionId: `claude-${index}`, kind: 'skipped', decision: 'skipped', context });
    await writeFile(join(ledger, new Date().toISOString().slice(0, 10) + '.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
const server = createServer();
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const port = (server.address() as {
    port: number;
}).port;
await new Promise<void>(done => server.close(() => done()));
const cliHome = join(fixture, 'codex-home');
await mkdir(cliHome);
await writeFile(join(cliHome, 'config.toml'), '');
const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts', '--port', String(port), '--no-discovery', ...projects.flatMap(p => ['--project', p])], { stdio: 'pipe', env: { ...process.env, CODEX_HOME: cliHome, CLAUDE_CONFIG_DIR: join(fixture, 'claude-home') } });
let output = '';
child.stdout?.on('data', c => output += c);
child.stderr?.on('data', c => output += c);
const url = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null)
            throw new Error(output);
        try {
            const r = await fetch(url + '/api/catalog');
            const c = await r.json() as {
                loading: boolean;
            };
            if (!c.loading) {
                ready = true;
                break;
            }
        }
        catch { }
        await new Promise(done => setTimeout(done, 100));
    }
    if (!ready)
        throw new Error('Server did not start: ' + output);
    await page.goto(url);
    await expect(page.getByTestId('execution-stats')).toContainText('4 invocations');
    const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
    await expect(agent).toHaveValue('all');
    await agent.selectOption('codex');
    await expect(page.getByTestId('execution-stats')).toContainText('2 invocations');
    await expect(page.getByTestId('execution-row')).not.toContainText(['Claude Code']);
    await page.getByRole('combobox', { name: 'Branch', exact: true }).selectOption('main');
    await expect(page.getByTestId('execution-stats')).toContainText('1 invocations');
    await page.getByRole('combobox', { name: 'Branch', exact: true }).selectOption('');
    await agent.selectOption('all');
    await page.getByRole('combobox', { name: 'Session', exact: true }).selectOption('codex:shared-session');
    await expect(page.getByTestId('execution-stats')).toContainText('2 invocations');
    await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('session');
    await expect(page.getByRole('region', { name: 'codex:shared-session · github.com/example/app', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Session', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: 'Checkout', exact: true }).selectOption(projects[1]);
    await expect(page.getByTestId('execution-stats')).toContainText('2 invocations');
    await page.getByRole('combobox', { name: 'Checkout', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('repository');
    await page.getByText(/Discovered sessions/).click();
    await page.route('**/api/session?*', route => route.fulfill({ json: { messages: [{ role: 'user', content: 'Fixture transcript content' }] } }));
    await page.getByRole('button', { name: 'View transcript', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Fixture transcript content');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.unroute('**/api/session?*');
    expect(await page.locator('header').count()).toBe(1);
    await page.screenshot({ path: join(evidence, 'executions-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(evidence, 'executions-mobile.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Hook settings', exact: true }).click();
    const checkout = page.getByRole('combobox', { name: 'Configuration checkout' });
    const options = await checkout.locator('option').evaluateAll(nodes => nodes.map(n => ({ id: (n as HTMLOptionElement).value, text: n.textContent ?? '' })));
    const a = options.find(o => o.text.includes(projects[0]))!, b = options.find(o => o.text.includes(projects[1]))!;
    await checkout.selectOption(a.id);
    for (const [, label] of events) {
        await page.getByRole('button', { name: label, exact: true }).click();
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
            const entry = page.getByTestId('event-command-status').filter({ visible: true });
            await expect(entry).toContainText('Claude Code:', { timeout: 20000 });
            await expect(entry).toContainText('Codex:');
            await expect(entry).toHaveAttribute('data-ready', 'false');
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Sub-hook settings' });
    await settings.getByLabel('Enabled', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Executions', exact: true }).click();
    await page.getByRole('button', { name: 'Hook settings', exact: true }).click();
    await expect(settings.getByLabel('Enabled', { exact: true })).not.toBeChecked();
    await checkout.selectOption(b.id);
    await expect(settings.getByLabel('Enabled', { exact: true })).toBeChecked();
    await checkout.selectOption(a.id);
    await expect(settings.getByLabel('Enabled', { exact: true })).not.toBeChecked();
    const beforeB = await readFile(join(projects[1], '.codex/hooks/registry.yaml'), 'utf8');
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings.getByRole('status')).toContainText('Saved');
    expect(await readFile(join(projects[1], '.codex/hooks/registry.yaml'), 'utf8')).toBe(beforeB);
    await page.reload();
    await page.getByRole('button', { name: 'Hook settings', exact: true }).click();
    await checkout.selectOption(a.id);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(settings.getByLabel('Enabled', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Open implementation', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('hook-source-viewer')).toContainText('never executes hooks');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Recent run', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Skipped', exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByRole('img', { name: 'Ran', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'How it works', exact: true }).click();
    await writeFile(join(projects[0], '.claude/settings.json'), JSON.stringify({ disableAllHooks: true }));
    await expect(page.getByTestId('event-command-status').filter({ visible: true })).toContainText('Hooks disabled', { timeout: 20000 });
    await page.getByRole('button', { name: 'User prompt', exact: true }).click();
    await page.screenshot({ path: join(evidence, 'settings-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, 'settings-mobile.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await rm(join(projects[0], '.codex/hooks/registry.yaml'));
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Hook registry could not be loaded' })).toBeVisible();
    expect(errors).toEqual([]);
    console.log('Browser smoke passed: both agents, repository/branch/checkout/session filters, grouping, all lifecycle tabs, desktop/mobile, per-checkout drafts and saves, source viewing, skipped results and recovery.');
}
finally {
    await browser.close();
    await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
    } child.once('exit', () => done()); child.kill('SIGTERM'); });
    await rm(fixture, { recursive: true, force: true });
}
