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

interface ManifestHistoryModule {
    defaultGitRunner: GitRunner;
}

interface MetadataUpdateOptions {
    rootDir?: string;
    gitRunner?: GitRunner;
    log?: boolean;
}

interface MetadataUpdateResult {
    processed: number;
    changed: number;
    unchanged: number;
    writes: string[];
}

interface MetadataModule {
    updateMetadata(
        directory: string,
        options?: MetadataUpdateOptions,
    ): MetadataUpdateResult;
}

const assert: typeof import('node:assert/strict') =
    require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const test: typeof import('node:test') = require('node:test');
const matter: typeof import('gray-matter') = require('gray-matter');
const {
    defaultGitRunner,
}: ManifestHistoryModule = require('../scripts/resolve_manifest_history.ts');
const {
    updateMetadata,
}: MetadataModule = require('../scripts/update_metadata.ts');

function runGit(rootDir: string, args: readonly string[]): string {
    const result = defaultGitRunner(rootDir, args);
    assert.equal(
        result.status,
        0,
        result.stderr || result.stdout || result.error?.message,
    );
    return result.stdout.trim();
}

function commitAt(
    rootDir: string,
    message: string,
    timestamp: string,
): void {
    const previousAuthorDate = process.env.GIT_AUTHOR_DATE;
    const previousCommitterDate = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_AUTHOR_DATE = timestamp;
    process.env.GIT_COMMITTER_DATE = timestamp;
    try {
        runGit(rootDir, ['commit', '-m', message]);
    } finally {
        if (previousAuthorDate === undefined) {
            delete process.env.GIT_AUTHOR_DATE;
        } else {
            process.env.GIT_AUTHOR_DATE = previousAuthorDate;
        }
        if (previousCommitterDate === undefined) {
            delete process.env.GIT_COMMITTER_DATE;
        } else {
            process.env.GIT_COMMITTER_DATE = previousCommitterDate;
        }
    }
}

function initializeRepository(rootDir: string): void {
    runGit(rootDir, ['init']);
    runGit(rootDir, ['config', 'user.name', 'Metadata Test']);
    runGit(rootDir, ['config', 'user.email', 'metadata@example.com']);
}

function article(title: string, body = '# Body'): string {
    return [
        '---',
        `title: ${JSON.stringify(title)}`,
        'tags:',
        '  - test',
        '---',
        '',
        body,
        '',
    ].join('\n');
}

function readTimestamp(filePath: string): unknown {
    return matter(fs.readFileSync(filePath, 'utf8')).data.local_updated_at;
}

function snapshot(filePaths: readonly string[]): Map<string, Buffer> {
    return new Map(
        filePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]),
    );
}

function assertSnapshotUnchanged(
    before: ReadonlyMap<string, Buffer>,
): void {
    for (const [filePath, bytes] of before) {
        assert.deepEqual(fs.readFileSync(filePath), bytes, filePath);
    }
}

test('metadata uses per-file Git commit time and ignores checkout mtime and unrelated commits', () => {
    const rootDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-metadata-git-'),
    );
    try {
        initializeRepository(rootDir);
        const articleDir = path.join(rootDir, 'articles', 'share');
        const articleA = path.join(articleDir, 'a.md');
        const articleB = path.join(articleDir, 'b.md');
        fs.mkdirSync(articleDir, { recursive: true });
        fs.writeFileSync(articleA, article('A'), 'utf8');
        fs.writeFileSync(articleB, article('B'), 'utf8');
        runGit(rootDir, ['add', '--', 'articles/share']);

        const firstCommitTime = '2024-01-02T03:04:05+00:00';
        commitAt(rootDir, 'add articles', firstCommitTime);

        fs.writeFileSync(articleB, article('B', '# Updated body'), 'utf8');
        runGit(rootDir, ['add', '--', 'articles/share/b.md']);
        const secondCommitTime = '2024-02-03T04:05:06+00:00';
        commitAt(rootDir, 'update article b', secondCommitTime);

        const unrelatedMtime = new Date('2035-06-07T08:09:10Z');
        fs.utimesSync(articleA, unrelatedMtime, unrelatedMtime);
        fs.utimesSync(articleB, unrelatedMtime, unrelatedMtime);

        const first = updateMetadata('articles/share', {
            rootDir,
            log: false,
        });
        assert.equal(first.processed, 2);
        assert.equal(first.changed, 2);
        assert.equal(readTimestamp(articleA), '2024-01-02T03:04:05Z');
        assert.equal(readTimestamp(articleB), '2024-02-03T04:05:06Z');

        const stableBytes = snapshot([articleA, articleB]);
        const laterMtime = new Date('2040-01-01T00:00:00Z');
        fs.utimesSync(articleA, laterMtime, laterMtime);
        fs.utimesSync(articleB, laterMtime, laterMtime);
        const second = updateMetadata('articles/share', {
            rootDir,
            log: false,
        });
        assert.equal(second.changed, 0);
        assertSnapshotUnchanged(stableBytes);

        fs.writeFileSync(
            path.join(rootDir, 'README.md'),
            'unrelated change\n',
            'utf8',
        );
        runGit(rootDir, ['add', '--', 'README.md']);
        commitAt(
            rootDir,
            'unrelated documentation',
            '2025-03-04T05:06:07+00:00',
        );
        fs.utimesSync(articleA, unrelatedMtime, unrelatedMtime);
        fs.utimesSync(articleB, unrelatedMtime, unrelatedMtime);

        const afterUnrelatedCommit = updateMetadata('articles/share', {
            rootDir,
            log: false,
        });
        assert.equal(afterUnrelatedCommit.changed, 0);
        assertSnapshotUnchanged(stableBytes);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('Git, missing-history, and parse failures happen before any metadata write', () => {
    const rootDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-metadata-failure-'),
    );
    try {
        initializeRepository(rootDir);
        const articleDir = path.join(rootDir, 'articles', 'share');
        const articleA = path.join(articleDir, 'a.md');
        const articleZ = path.join(articleDir, 'z.md');
        fs.mkdirSync(articleDir, { recursive: true });
        fs.writeFileSync(articleA, article('A'), 'utf8');
        fs.writeFileSync(articleZ, article('Z'), 'utf8');
        runGit(rootDir, ['add', '--', 'articles/share']);
        commitAt(
            rootDir,
            'add tracked articles',
            '2024-01-02T03:04:05+00:00',
        );

        const beforeGitFailure = snapshot([articleA, articleZ]);
        assert.throws(
            () =>
                updateMetadata('articles/share', {
                    rootDir,
                    log: false,
                    gitRunner: (gitRoot, args) =>
                        args.at(-1) === 'articles/share/z.md'
                            ? {
                                  status: 128,
                                  stdout: '',
                                  stderr: 'simulated Git failure',
                              }
                            : defaultGitRunner(gitRoot, args),
                }),
            /simulated Git failure/,
        );
        assertSnapshotUnchanged(beforeGitFailure);

        const untrackedArticle = path.join(articleDir, 'zz-untracked.md');
        fs.writeFileSync(untrackedArticle, article('Untracked'), 'utf8');
        const beforeMissingHistory = snapshot([
            articleA,
            articleZ,
            untrackedArticle,
        ]);
        assert.throws(
            () =>
                updateMetadata('articles/share', {
                    rootDir,
                    log: false,
                }),
            /No Git commit history exists/,
        );
        assertSnapshotUnchanged(beforeMissingHistory);

        runGit(rootDir, ['add', '--', 'articles/share/zz-untracked.md']);
        commitAt(
            rootDir,
            'track final article',
            '2024-02-03T04:05:06+00:00',
        );
        fs.writeFileSync(
            untrackedArticle,
            '---\ntitle: [\n---\ninvalid\n',
            'utf8',
        );
        const beforeParseFailure = snapshot([
            articleA,
            articleZ,
            untrackedArticle,
        ]);
        assert.throws(
            () =>
                updateMetadata('articles/share', {
                    rootDir,
                    log: false,
                }),
            /Cannot parse article/,
        );
        assertSnapshotUnchanged(beforeParseFailure);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});
