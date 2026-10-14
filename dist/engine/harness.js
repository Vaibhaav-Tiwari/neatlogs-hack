import { createHash } from 'node:crypto';
export const AO_HARNESS_PERMISSIONS = { codex: 'auto', 'claude-code': 'default' };
/** CLI-owned status only: never inspect credential files or invoke inference. */
export async function checkHarness(harness, command, cwd) {
    const file = harness === 'claude-code' ? 'claude' : 'codex';
    const fix = harness === 'claude-code' ? 'claude auth login' : 'codex login';
    try {
        await command(file, ['--version'], { cwd });
    }
    catch {
        return { harness, installed: false, signedIn: false, detail: `${file} is not installed or could not run. Install it before using ${harness} tiers.`, fix: `Install ${harness === 'claude-code' ? 'Claude Code (https://code.claude.com/docs/en/setup)' : 'Codex CLI (https://developers.openai.com/codex/cli/)'} and then run ${fix}.` };
    }
    try {
        const output = await command(file, harness === 'claude-code' ? ['auth', 'status'] : ['login', 'status'], { cwd });
        const signedIn = harness === 'claude-code' ? JSON.parse(output.stdout).loggedIn === true
            : /\blogged in\b/i.test(`${output.stdout}\n${output.stderr}`) && !/\bnot logged in\b/i.test(`${output.stdout}\n${output.stderr}`);
        return { harness, installed: true, signedIn, detail: signedIn ? `${file} is installed and signed in. Model access was not probed.` : `${file} is signed out or its sign-in status could not be verified.`, fix };
    }
    catch {
        return { harness, installed: true, signedIn: false, detail: `${file} is signed out or its sign-in status could not be verified`, fix };
    }
}
export function claudeAllowList(test) {
    const commands = ['git add *', 'git commit *', 'git status', 'git status *', 'git diff', 'git diff *'];
    return [...new Set(['Edit(./**)', 'Write(./**)', ...commands.map(value => `Bash(${value})`), ...claudeScripts(test).map(script => script.rule)])];
}
export function claudeScripts(test) {
    const commands = [test.command, ...(test.setupCommand ? [test.setupCommand] : [])];
    if (commands.some(value => /[\r\n]/.test(value)))
        throw new Error('Claude allow-list needs single-line test and setup commands');
    if (commands.some(value => value.includes('\0')))
        throw new Error('Claude script commands cannot contain NUL');
    return commands.map((command, index) => {
        const name = index === 0 ? 'test' : 'setup';
        const contents = `#!/bin/sh\nset -e\n${command}\n`;
        const hash = createHash('sha256').update(contents).digest('hex');
        return { name, contents, rule: `Bash({{tally.${name}Script:${hash}}})` };
    });
}
export function requireClaudeScriptConsent(allow, test) {
    const expected = claudeAllowList(test);
    if (!allow?.length || allow.length !== expected.length || expected.some(rule => !allow.includes(rule))) {
        throw new Error('Claude Code script consent is missing or outdated (old raw-command rules do not authorize scripts); re-run tally init to review and approve the current test/setup script contents.');
    }
}
//# sourceMappingURL=harness.js.map