import { runCommand } from './command.js';
import { resolve } from 'node:path';
import { entireSessionUrl } from './evidence-links.js';
const execFileAsync = runCommand;
function defaultCommand(file, args, options) {
    return execFileAsync(file, args, { cwd: options?.cwd, maxBuffer: 10 * 1024 * 1024 });
}
function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function checkpointId(value) {
    return text(value.checkpoint_id) ?? text(value.condensation_id) ?? text(value.id);
}
function checkpointUrl(value) {
    return text(value.url) ?? text(value.web_url) ?? text(value.html_url);
}
function latestForSession(checkpoints, sessionId) {
    return checkpoints
        .filter((candidate) => text(candidate.session_id) === sessionId && checkpointId(candidate))
        .sort((a, b) => String(text(b.date) ?? '').localeCompare(String(text(a.date) ?? '')))[0] ?? null;
}
function trailerFrom(message) {
    return /^Entire-Checkpoint:\s*(\S+)/im.exec(message)?.[1] ?? null;
}
function trimSummary(output) {
    return output
        .split(/\r?\n/)
        .filter((line) => !/^Generating checkpoint summary|^→ |^✓ |^✗ /.test(line.trim()))
        .join('\n')
        .trim()
        .slice(0, 4000);
}
export class EntireCheckpointAdapter {
    command;
    repoPath;
    summaryTimeoutSec;
    generatedSummaries;
    repoSlug;
    mirrorReadyPromise;
    constructor(options) {
        this.command = options.command ?? defaultCommand;
        this.repoPath = options.repoPath;
        this.summaryTimeoutSec = options.summaryTimeoutSec ?? 45;
        this.generatedSummaries = options.generatedSummaries === true;
        this.repoSlug = options.repoSlug;
    }
    async checkpointFor(context) {
        const found = await this.findCheckpoint(context);
        return found ? { checkpointId: found.checkpointId, checkpointUrl: found.checkpointUrl, entireSessionId: found.entireSessionId ?? null } : null;
    }
    async sessionIdFor(context) {
        // Killed workers may have no commit, but prompt-submit has already registered a session.
        // Read the shared repository after AO removes the worker worktree.
        const result = await this.command('entire', ['session', 'list', '--json'], { cwd: this.repoPath }).catch(() => null);
        const sessions = parseJson(result?.stdout ?? '');
        if (!Array.isArray(sessions))
            return null;
        const exact = sessions.filter(s => text(s.session_id) === context.sessionId || text(s.worktree_id) === context.sessionId);
        const candidates = exact.length ? exact : sessions.filter(s => {
            if (text(s.worktree_id))
                return false;
            const path = text(s.worktree_path);
            if (path)
                return !!context.checkoutPath && resolve(path) === resolve(context.checkoutPath);
            return !!context.branch && text(s.branch) === context.branch;
        });
        // Same-branch continuation must not inherit an earlier worker's capture session.
        return candidates.length === 1 ? text(candidates[0]?.session_id) : null;
    }
    async summaryFor(sessionId, context = {}) {
        const found = await this.findCheckpoint({ ...context, sessionId });
        if (!found)
            return null;
        const generated = this.generatedSummaries ? await this.command('entire', ['checkpoint', 'explain', found.checkpointId, '--generate', '--summary-timeout-seconds', String(this.summaryTimeoutSec), '--no-pager'], { cwd: context.checkoutPath ?? this.repoPath }).catch(() => null) : null;
        let summary = trimSummary(generated?.stdout ?? '');
        if (!summary || /not generated yet|run .*checkpoint explain.*--generate/i.test(summary)) {
            const branch = context.branch ?? found.branch;
            const diff = context.changedFiles ? null : await this.command('git', ['show', '--format=', '--name-only', '-z', '--end-of-options', branch ?? 'HEAD', '--'], {
                cwd: context.checkoutPath ?? this.repoPath,
            }).catch(() => null);
            const changedFiles = context.changedFiles ?? (diff ? diff.stdout.split('\0').filter(Boolean) : null);
            summary = [
                'Metadata-only handoff; no generated summary or transcript export was requested.',
                `Checkpoint: ${found.checkpointId}; native session: ${found.entireSessionId ?? '(unknown)'}.`,
                `Branch: ${branch ?? '(unknown)'}.`,
                `Checkpoint files: ${found.filesTouched.length ? found.filesTouched.join(', ') : '(unavailable)'}.`,
                `Changed files: ${changedFiles === null ? '(unavailable)' : changedFiles.length ? changedFiles.join(', ') : '(none)'}.`,
                `Attempt verdict: ${context.result ?? '(unknown)'}${context.resultReason ? ` - ${context.resultReason}` : ''}.`,
                ...(context.task ? [`Task ${context.task.taskId}: ${context.task.title}`, context.task.body] : []),
                'Inspect the branch changes and rerun the failed tests before continuing.',
            ].join('\n');
        }
        if (!summary)
            return null;
        return {
            type: 'entire-handoff',
            summary,
            branch: context.branch ?? found.branch ?? null,
            checkpointId: found.checkpointId,
            checkpointUrl: found.checkpointUrl,
            summaryCostNanos: 0,
            summaryCostSource: 'ao-estimate',
        };
    }
    async findCheckpoint(context) {
        if (context.checkpointId)
            return this.explain(context.checkpointId, context);
        // AO session ids differ from Codex session ids; the task commit is authoritative.
        if (context.branch || context.checkoutPath) {
            const log = await this.command('git', ['log', '-1', '--format=%B', '--end-of-options', context.branch ?? 'HEAD', '--'], {
                cwd: context.checkoutPath ?? this.repoPath,
            }).catch(() => null);
            const trailer = log ? trailerFrom(log.stdout) : null;
            if (trailer)
                return this.explain(trailer, context);
        }
        const session = await this.sessionInfo(context.sessionId, context.checkoutPath);
        const sessionCheckpoint = text(session?.last_checkpoint_id) ?? checkpointId(session ?? {});
        if (sessionCheckpoint)
            return this.explain(sessionCheckpoint, { ...context, branch: text(session?.branch) ?? context.branch ?? null });
        const pending = await this.checkpointList(['checkpoint', 'list', '--pending', '--json'], context.checkoutPath);
        const pendingMatch = latestForSession(pending, context.sessionId);
        if (pendingMatch)
            return this.explain(checkpointId(pendingMatch), { ...context, branch: text(pendingMatch.branch) ?? context.branch ?? null });
        const condensed = await this.checkpointList(['checkpoint', 'list', '--json', '--session', context.sessionId], context.checkoutPath);
        const condensedMatch = latestForSession(condensed, context.sessionId);
        if (condensedMatch)
            return this.explain(checkpointId(condensedMatch), { ...context, branch: text(condensedMatch.branch) ?? context.branch ?? null });
        return null;
    }
    async sessionInfo(sessionId, cwd) {
        const result = await this.command('entire', ['session', 'info', sessionId, '--json'], { cwd: cwd ?? this.repoPath }).catch(() => null);
        return result ? parseJson(result.stdout) : null;
    }
    async checkpointList(args, cwd) {
        const result = await this.command('entire', args, { cwd: cwd ?? this.repoPath }).catch(() => null);
        return parseJson(result?.stdout ?? '') ?? [];
    }
    async explain(id, context) {
        const result = await this.command('entire', ['checkpoint', 'explain', id, '--json', '--no-pager'], { cwd: context.checkoutPath ?? this.repoPath }).catch(() => null);
        const parsed = result ? parseJson(result.stdout) : null;
        const checkpoint = checkpointId(parsed ?? {}) ?? id;
        const entireSessionId = text(parsed?.sessions?.[parsed.sessions.length - 1]?.session_id);
        const explicitUrl = parsed ? checkpointUrl(parsed) : null;
        const hostedUrl = explicitUrl ?? (entireSessionId && await this.hasReadyMirror()
            ? entireSessionUrl(this.repoSlug, entireSessionId)
            : null);
        return {
            checkpointId: checkpoint,
            checkpointUrl: hostedUrl,
            branch: text(parsed?.branch) ?? context.branch ?? null,
            entireSessionId,
            filesTouched: Array.isArray(parsed?.files_touched) ? parsed.files_touched.filter((file) => typeof file === 'string') : [],
        };
    }
    async hasReadyMirror() {
        if (!this.repoSlug)
            return false;
        this.mirrorReadyPromise ??= (async () => {
            const result = await this.command('entire', ['repo', 'mirror', 'list', '--json', '--mirrored', '--name', this.repoSlug], { cwd: this.repoPath }).catch(() => null);
            const parsed = parseJson(result?.stdout ?? '');
            const records = Array.isArray(parsed) ? parsed : parsed?.items ?? [];
            return records.some(record => record.repo === `/gh/${this.repoSlug}`
                && record.placements?.some(placement => placement.status === 'ready'));
        })();
        return this.mirrorReadyPromise;
    }
}
//# sourceMappingURL=entire-checkpoints.js.map