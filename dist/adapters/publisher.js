import { runCommand } from './command.js';
const execFileAsync = runCommand;
const EVIDENCE_START = '<!-- tally-run-evidence:start -->';
const EVIDENCE_END = '<!-- tally-run-evidence:end -->';
function evidenceMarkdown(links) {
    if (!links.length)
        return '';
    const lines = [EVIDENCE_START, '### Tally run evidence', ...links.map(({ label, url, note }) => `- [${label}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})${note ? ` — ${note.replace(/[\r\n]/g, ' ')}` : ''}`), EVIDENCE_END];
    return lines.join('\n');
}
export function replacePrEvidence(body, links) {
    const evidence = evidenceMarkdown(links);
    const existing = new RegExp(`${EVIDENCE_START}[\\s\\S]*?${EVIDENCE_END}`, 'm');
    if (!evidence)
        return body.replace(existing, '').trimEnd();
    if (existing.test(body))
        return body.replace(existing, () => evidence);
    return `${body.trimEnd()}${body.trim() ? '\n\n' : ''}${evidence}`;
}
function defaultCommand(file, args, options) {
    return execFileAsync(file, args, { cwd: options?.cwd, timeout: options?.timeout, env: options?.env });
}
const GH_GIT_CREDENTIAL = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
function pushWithGithubCli(command, remote, refspecs, cwd, upstream = false) {
    const useGhCredential = remote === 'origin';
    const credentialArgs = useGhCredential ? GH_GIT_CREDENTIAL : [];
    const args = [...credentialArgs, 'push', ...(upstream ? ['-u'] : []), remote, ...refspecs];
    const options = {
        cwd,
        ...(useGhCredential ? { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } : {}),
    };
    return command('git', args, options).catch(async () => {
        // A GitHub receive-pack can reject a push without a useful reason during a
        // transient remote failure. Repeating the same ref update is safe: an
        // already accepted push is reported as up to date, and a permanent
        // rejection still surfaces from this single retry.
        await new Promise((resolve) => setTimeout(resolve, 500));
        return command('git', args, options);
    });
}
function errorMessage(error) {
    const e = error;
    return typeof e.stderr === 'string' && e.stderr.trim() ? e.stderr.trim() : typeof e.message === 'string' ? e.message : String(error);
}
function prBody(input) {
    const issue = input.task.issueUrl ? `\n\nCloses ${input.task.issueUrl}` : input.task.issueNumber ? `\n\nCloses #${input.task.issueNumber}` : '';
    const warning = input.scopeWarnings?.length ? `\n\nScope warning: out-of-scope changes: ${input.scopeWarnings.join(', ')}` : '';
    return [`Tally run ${input.runId}, task ${input.task.taskId}, attempt ${input.attempt}.`, '', input.task.body || '(No issue body was provided.)', issue, warning].filter((part, index) => index < 4 || part).join('\n');
}
export class GitHubPublisher {
    command;
    constructor(command = defaultCommand) {
        this.command = command;
    }
    async changedFiles(input) {
        const base = input.baseCommit ?? `origin/${input.config.repo.baseBranch}`;
        const { stdout } = await this.command('git', ['diff', '--name-only', '-z', '--end-of-options', base, input.branch, '--'], { cwd: input.checkoutPath });
        return stdout.split('\0').filter(Boolean);
    }
    async commitsAhead(input) {
        try {
            const { stdout } = await this.command('git', ['rev-list', '--count', `origin/${input.config.repo.baseBranch}..HEAD`], { cwd: input.checkoutPath });
            return Number.parseInt(stdout.trim(), 10) || 0;
        }
        catch {
            const { stdout } = await this.command('git', ['rev-list', '--count', `${input.config.repo.baseBranch}..HEAD`], { cwd: input.checkoutPath });
            return Number.parseInt(stdout.trim(), 10) || 0;
        }
    }
    async publishPr(input) {
        if (!input.config.repo.slug)
            throw new Error('repo.slug is required to open a GitHub pull request');
        await pushWithGithubCli(this.command, 'origin', [`HEAD:${input.branch}`], input.checkoutPath, true);
        if (input.config.integrations.entire)
            await this.pushCheckpoints(input);
        try {
            const { stdout } = await this.command('gh', [
                'pr',
                'create',
                '--repo',
                input.config.repo.slug,
                '--head',
                input.branch,
                '--base',
                input.config.repo.baseBranch,
                '--title',
                `${input.task.taskId}: ${input.task.title}`,
                '--body',
                prBody(input),
            ], { cwd: input.checkoutPath });
            return stdout.trim();
        }
        catch (error) {
            const message = errorMessage(error);
            if (!/already exists/i.test(message))
                throw error;
            const { stdout } = await this.command('gh', ['pr', 'view', '--repo', input.config.repo.slug, '--head', input.branch, '--json', 'url', '-q', '.url'], {
                cwd: input.checkoutPath,
            });
            return stdout.trim();
        }
    }
    async updatePrEvidence(input) {
        if (!input.config.repo.slug)
            throw new Error('repo.slug is required to update a GitHub pull request');
        if (!input.links.length)
            return;
        // Evidence is best-effort after publishing: never wait indefinitely on gh.
        const { stdout } = await this.command('gh', ['pr', 'view', input.prUrl, '--repo', input.config.repo.slug, '--json', 'body', '-q', '.body'], { timeout: 15_000 });
        const body = replacePrEvidence(stdout.replace(/\r?\n$/, ''), input.links);
        await this.command('gh', ['pr', 'edit', input.prUrl, '--repo', input.config.repo.slug, '--body', body], { timeout: 15_000 });
    }
    async pushCheckpoints(input) {
        const options = { cwd: input.checkoutPath };
        const { stdout: messages } = await this.command('git', [
            'log', '--format=%B', '--end-of-options', `origin/${input.config.repo.baseBranch}..${input.branch}`, '--',
        ], options);
        const ids = new Set(Array.from(messages.matchAll(/^Entire-Checkpoint:\s*([A-Za-z0-9]+)\s*$/gm), (match) => match[1]));
        if (!ids.size)
            return;
        const { stdout: refsOutput } = await this.command('git', ['for-each-ref', '--format=%(refname)', 'refs/entire/checkpoints/'], options);
        const refs = refsOutput.trim().split(/\r?\n/).filter((ref) => ids.has(ref.split('/').at(-1)));
        for (const id of ids) {
            if (!refs.some((ref) => ref.endsWith(`/${id}`)))
                throw new Error(`Entire checkpoint ref missing for ${id}`);
        }
        const { stdout: remotes } = await this.command('git', ['remote'], options);
        for (const remote of ['origin', ...(remotes.split(/\r?\n/).includes('entire') ? ['entire'] : [])]) {
            await pushWithGithubCli(this.command, remote, refs.map((ref) => `${ref}:${ref}`), input.checkoutPath);
        }
    }
}
//# sourceMappingURL=publisher.js.map