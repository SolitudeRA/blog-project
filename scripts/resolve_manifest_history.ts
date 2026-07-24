'use strict';

interface GitExecutionResult {
    error?: Error;
    signal?: NodeJS.Signals | null;
    status: number | null;
    stdout: string;
    stderr: string;
}

type GitRunner = (
    rootDir: string,
    args: readonly string[],
) => GitExecutionResult;

interface ManifestHistoryOptions {
    rootDir?: string;
    baselineRef?: string;
    gitRunner?: GitRunner;
}

interface HistoricalManifest {
    content: string;
    sourceRef: string;
    recoveredFromHistory: true;
}

interface ManifestHistoryResult {
    content?: string;
    initialIntroduction: boolean;
    baselineRef: string;
    sourceRef: string | null;
    recoveredFromHistory?: boolean;
}

interface CliOptions {
    baselineRef: string;
    outputPath: string;
    githubOutputPath: string;
}

const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') =
    require('node:child_process');

const MANIFEST_PATH = 'articles/manifest.json';
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function defaultGitRunner(
    rootDir: string,
    args: readonly string[],
): GitExecutionResult {
    const captureDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-manifest-history-'),
    );
    const stdoutPath = path.join(captureDir, 'stdout');
    const stderrPath = path.join(captureDir, 'stderr');
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;

    try {
        stdoutFd = fs.openSync(stdoutPath, 'wx');
        stderrFd = fs.openSync(stderrPath, 'wx');
        const result = spawnSync('git', args, {
            cwd: rootDir,
            shell: false,
            stdio: ['ignore', stdoutFd, stderrFd],
        });
        fs.closeSync(stdoutFd);
        stdoutFd = undefined;
        fs.closeSync(stderrFd);
        stderrFd = undefined;

        return {
            error: result.error,
            signal: result.signal,
            status: result.status,
            stdout: fs.readFileSync(stdoutPath, 'utf8'),
            stderr: fs.readFileSync(stderrPath, 'utf8'),
        };
    } finally {
        if (stdoutFd !== undefined) {
            fs.closeSync(stdoutFd);
        }
        if (stderrFd !== undefined) {
            fs.closeSync(stderrFd);
        }
        fs.rmSync(captureDir, { recursive: true, force: true });
    }
}

function assertGitSuccess(
    result: GitExecutionResult,
    operation: string,
): void {
    if (result.error) {
        throw new Error(`${operation} could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(
            `${operation} failed${detail ? `: ${detail}` : ''}`,
        );
    }
}

function assertCommit(
    rootDir: string,
    ref: string,
    gitRunner: GitRunner,
): void {
    const result = gitRunner(rootDir, [
        'cat-file',
        '-e',
        `${ref}^{commit}`,
    ]);
    assertGitSuccess(result, `checking baseline commit ${ref}`);
}

function manifestExistsAt(
    rootDir: string,
    ref: string,
    gitRunner: GitRunner,
): boolean {
    const result = gitRunner(rootDir, [
        'ls-tree',
        '-z',
        '--name-only',
        ref,
        '--',
        MANIFEST_PATH,
    ]);
    assertGitSuccess(result, `inspecting ${MANIFEST_PATH} at ${ref}`);
    const entries = result.stdout.split('\0').filter(Boolean);
    if (
        entries.length > 1 ||
        entries.some((entry) => entry !== MANIFEST_PATH)
    ) {
        throw new Error(
            `unexpected tree entries for ${MANIFEST_PATH} at ${ref}`,
        );
    }
    return entries.length === 1;
}

function readManifestAt(
    rootDir: string,
    ref: string,
    gitRunner: GitRunner,
): string {
    const result = gitRunner(rootDir, [
        'show',
        `${ref}:${MANIFEST_PATH}`,
    ]);
    assertGitSuccess(result, `reading ${MANIFEST_PATH} at ${ref}`);
    return result.stdout;
}

function resolveZeroBaseline(
    rootDir: string,
    gitRunner: GitRunner,
): null {
    const result = gitRunner(rootDir, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        'HEAD',
    ]);
    assertGitSuccess(result, 'checking HEAD parents for a zero baseline');
    const commits = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (
        commits.length === 0 ||
        commits.some((commit) => !FULL_COMMIT_PATTERN.test(commit))
    ) {
        throw new Error('HEAD parent inspection returned invalid commit IDs');
    }
    if (commits.length === 1) {
        return null;
    }
    throw new Error(
        'a zero baseline is only allowed for a root commit; '
        + 'refusing bootstrap on an existing history',
    );
}

function findHistoricalManifest(
    rootDir: string,
    baselineRef: string,
    gitRunner: GitRunner,
): HistoricalManifest | null {
    const history = gitRunner(rootDir, [
        'log',
        '--full-history',
        '--format=%H',
        baselineRef,
        '--',
        MANIFEST_PATH,
    ]);
    assertGitSuccess(
        history,
        `searching reachable ${MANIFEST_PATH} history at ${baselineRef}`,
    );
    const commits = history.stdout.split(/\r?\n/).filter(Boolean);
    if (commits.some((commit) => !FULL_COMMIT_PATTERN.test(commit))) {
        throw new Error(
            `invalid commit returned while searching ${MANIFEST_PATH} history`,
        );
    }

    for (const commit of commits) {
        if (manifestExistsAt(rootDir, commit, gitRunner)) {
            return {
                content: readManifestAt(rootDir, commit, gitRunner),
                sourceRef: commit,
                recoveredFromHistory: true,
            };
        }
    }
    return null;
}

function loadPreviousManifestFromGit(
    options: ManifestHistoryOptions = {},
): ManifestHistoryResult {
    const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
    const baselineRef = options.baselineRef;
    const gitRunner = options.gitRunner || defaultGitRunner;

    if (typeof baselineRef !== 'string' || baselineRef.length === 0) {
        throw new TypeError('baselineRef is required');
    }

    if (/^0+$/.test(baselineRef)) {
        const rootBaseline = resolveZeroBaseline(rootDir, gitRunner);
        if (rootBaseline === null) {
            return {
                initialIntroduction: true,
                baselineRef,
                sourceRef: null,
            };
        }
    }

    assertCommit(rootDir, baselineRef, gitRunner);
    if (manifestExistsAt(rootDir, baselineRef, gitRunner)) {
        return {
            content: readManifestAt(rootDir, baselineRef, gitRunner),
            initialIntroduction: false,
            baselineRef,
            sourceRef: baselineRef,
            recoveredFromHistory: false,
        };
    }

    const historical = findHistoricalManifest(
        rootDir,
        baselineRef,
        gitRunner,
    );
    if (historical) {
        return {
            ...historical,
            initialIntroduction: false,
            baselineRef,
        };
    }
    return {
        initialIntroduction: true,
        baselineRef,
        sourceRef: null,
    };
}

function parseCliArgs(args: readonly string[]): CliOptions {
    const options: Partial<CliOptions> = {};
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`missing value for ${name || '(option)'}`);
        }
        if (name === '--baseline-ref') {
            options.baselineRef = value;
        } else if (name === '--output') {
            options.outputPath = path.resolve(value);
        } else if (name === '--github-output') {
            options.githubOutputPath = path.resolve(value);
        } else {
            throw new Error(`unknown option: ${name}`);
        }
    }
    if (
        !options.baselineRef ||
        !options.outputPath ||
        !options.githubOutputPath
    ) {
        throw new Error(
            'usage: node scripts/resolve_manifest_history.ts '
            + '--baseline-ref <ref> --output <path> '
            + '--github-output <path>',
        );
    }
    return options as CliOptions;
}

function writeGitHubResult(
    options: CliOptions,
    result: ManifestHistoryResult,
): void {
    let previousManifestPath = '';
    if (!result.initialIntroduction) {
        fs.writeFileSync(options.outputPath, result.content!, {
            encoding: 'utf8',
            flag: 'wx',
        });
        previousManifestPath = options.outputPath;
    }
    fs.appendFileSync(
        options.githubOutputPath,
        `path=${previousManifestPath}\n`,
        'utf8',
    );
}

module.exports = {
    defaultGitRunner,
    findHistoricalManifest,
    loadPreviousManifestFromGit,
    parseCliArgs,
    writeGitHubResult,
};

if (require.main === module) {
    try {
        const options = parseCliArgs(process.argv.slice(2));
        const result = loadPreviousManifestFromGit(options);
        writeGitHubResult(options, result);
        if (result.initialIntroduction) {
            console.log(
                'No reachable articles/manifest.json history exists; '
                + 'initial introduction is allowed.',
            );
        } else if (result.recoveredFromHistory) {
            console.log(
                `Recovered the previous manifest from ${result.sourceRef}.`,
            );
        } else {
            console.log(`Loaded the previous manifest from ${result.sourceRef}.`);
        }
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}
