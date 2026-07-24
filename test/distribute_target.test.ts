'use strict';

import type {
    CommandOptions,
    CommandResult,
    CommandRunner,
    DistributeTargetExports,
    PublishMetadata,
} from '../scripts/distribute_target.ts';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const test: typeof import('node:test') = require('node:test');

const {
    AUTOMATION_BRANCH,
    MAX_ENVELOPE_BYTES,
    TARGETS,
    applyTarget,
    assertAutomationTrailer,
    assertOnlyAllowedChanges,
    buildCommitMessage,
    defaultCommandRunner,
    exportTarget,
    loadPublishMetadata,
    parseCliArgs,
    prepareTarget,
    publishTarget,
    rebuildPrePublish,
    rulesetRequiredCheckIsValid,
    validateRepositoryPolicyPayload,
} = require('../scripts/distribute_target.ts') as DistributeTargetExports;

const BASE_SHA = '1'.repeat(40);
const REMOTE_SHA = '2'.repeat(40);
const COMMIT_SHA = '3'.repeat(40);
const TOKEN = 'ghp_test_secret_that_must_not_leak';

test('command runner captures patch-sized output beyond the Node default', () => {
    const outputBytes = 1024 * 1024 + 4096;
    const result = defaultCommandRunner(
        process.execPath,
        ['-e', `process.stdout.write('x'.repeat(${outputBytes}))`],
        { cwd: __dirname },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.length, outputBytes);
});

function distributionEnvelope(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        schema: 1,
        target: 'qiita',
        repository: 'SolitudeRA/Qiita-Repo',
        baseSha: BASE_SHA,
        sourceSha: 'a'.repeat(40),
        patch: 'diff --git a/pre-publish/a.md b/pre-publish/a.md\n',
        ...overrides,
    };
}

function publishEnvironment(): NodeJS.ProcessEnv {
    return {
        GH_TOKEN: TOKEN,
        GITHUB_SHA: 'a'.repeat(40),
        DISTRIBUTION_SOURCE_TIMESTAMP: '2026-07-24T10:00:00+08:00',
        GITHUB_REPOSITORY: 'SolitudeRA/Blog-Project',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
    };
}

function metadata(): PublishMetadata {
    return loadPublishMetadata(publishEnvironment());
}

function makeDirectory(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'blog-distribution-test-'));
}

function writeFile(root: string, relativePath: string, content: string): void {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, 'utf8');
}

interface RecordedCall {
    args: readonly string[];
    command: string;
    options: CommandOptions;
}

interface FakeRunnerOptions {
    autoMergeRequest?: unknown | null;
    changed?: boolean;
    mainSha?: string;
    mainShaSequence?: readonly string[];
    openPullRequest?: boolean;
    outsidePath?: string;
    patch?: string;
    pullRequestDraft?: boolean;
    stagedIndexEntries?: string;
    remoteBranchSha?: string | null;
    remoteBranchShaSequence?: readonly (string | null)[];
    remoteTrailer?: string;
    rulesPolicy?: unknown;
}

class FakeRunner {
    readonly calls: RecordedCall[] = [];
    readonly root: string;
    readonly options: Required<FakeRunnerOptions>;
    commitCreated = false;
    mainLookupCount = 0;
    prCreated = false;
    pushed = false;
    remoteBranchLookupCount = 0;
    remoteBranchCurrentSha: string | null;

    constructor(root: string, options: FakeRunnerOptions = {}) {
        this.root = root;
        this.options = {
            autoMergeRequest:
                options.autoMergeRequest === undefined
                    ? null
                    : options.autoMergeRequest,
            changed: options.changed ?? true,
            mainSha: options.mainSha ?? BASE_SHA,
            mainShaSequence: options.mainShaSequence ?? [],
            openPullRequest: options.openPullRequest ?? true,
            outsidePath: options.outsidePath ?? '',
            patch: options.patch ?? '',
            pullRequestDraft: options.pullRequestDraft ?? false,
            stagedIndexEntries: options.stagedIndexEntries ?? '',
            remoteBranchSha:
                options.remoteBranchSha === undefined
                    ? REMOTE_SHA
                    : options.remoteBranchSha,
            remoteBranchShaSequence: options.remoteBranchShaSequence ?? [],
            remoteTrailer:
                options.remoteTrailer
                ?? [
                    'chore: prior automation',
                    '',
                    'Automated-By: Blog-Project',
                    `Distribution-Source: SolitudeRA/Blog-Project@${'b'.repeat(40)}`,
                    '',
                ].join('\n'),
            rulesPolicy: options.rulesPolicy ?? [
                {
                    type: 'required_status_checks',
                    parameters: {
                        strict_required_status_checks_policy: true,
                        required_status_checks: [
                            {
                                context: 'validate_and_publish',
                                integration_id: 15368,
                            },
                        ],
                    },
                },
            ],
        };
        this.remoteBranchCurrentSha = this.options.remoteBranchSha;
    }

    result(
        status = 0,
        stdout = '',
        stderr = '',
    ): CommandResult {
        return { status, stdout, stderr };
    }

    pullRequest(headSha: string): string {
        return JSON.stringify([
            {
                autoMergeRequest: this.options.autoMergeRequest,
                baseRefName: 'main',
                headRefName: AUTOMATION_BRANCH,
                headRefOid: headSha,
                headRepositoryOwner: { login: 'SolitudeRA' },
                isDraft: this.options.pullRequestDraft,
                number: 42,
                url: 'https://github.com/SolitudeRA/Qiita-Repo/pull/42',
            },
        ]);
    }

    run: CommandRunner = (
        command: string,
        args: readonly string[],
        options: CommandOptions,
    ): CommandResult => {
        this.calls.push({ command, args: [...args], options });
        const effectiveArgs =
            command === 'git'
            && args[0] === '-c'
            && args[1] === 'credential.helper=!gh auth git-credential'
                ? args.slice(2)
                : args;
        const joined = effectiveArgs.join(' ');

        if (command === 'gh') {
            if (args[0] === 'api' && args[1] === 'repos/SolitudeRA/Qiita-Repo') {
                return this.result(
                    0,
                    JSON.stringify({
                        full_name: 'SolitudeRA/Qiita-Repo',
                        default_branch: 'main',
                        allow_auto_merge: true,
                        allow_rebase_merge: true,
                        delete_branch_on_merge: true,
                    }),
                );
            }
            if (joined.includes('rules/branches/main')) {
                return this.result(
                    0,
                    JSON.stringify(this.options.rulesPolicy),
                );
            }
            if (args[0] === 'pr' && args[1] === 'list') {
                if (this.prCreated) {
                    return this.result(0, this.pullRequest(COMMIT_SHA));
                }
                if (this.options.openPullRequest) {
                    return this.result(
                        0,
                        this.pullRequest(
                            this.pushed ? COMMIT_SHA : REMOTE_SHA,
                        ),
                    );
                }
                return this.result(0, '[]');
            }
            if (args[0] === 'pr' && args[1] === 'create') {
                this.prCreated = true;
                return this.result(
                    0,
                    'https://github.com/SolitudeRA/Qiita-Repo/pull/42\n',
                );
            }
            return this.result();
        }

        assert.equal(command, 'git');
        if (joined === 'rev-parse --show-toplevel') {
            return this.result(0, `${this.root}\n`);
        }
        if (joined === 'remote get-url origin') {
            return this.result(
                0,
                'https://github.com/SolitudeRA/Qiita-Repo.git\n',
            );
        }
        if (joined.includes('symbolic-ref --quiet --short HEAD')) {
            return this.result(0, `${AUTOMATION_BRANCH}\n`);
        }
        if (
            effectiveArgs[0] === 'diff'
            && effectiveArgs.includes('--name-only')
        ) {
            return this.result(
                0,
                this.options.outsidePath
                    ? `${this.options.outsidePath}\0`
                    : 'pre-publish/a.md\0',
            );
        }
        if (
            effectiveArgs[0] === 'ls-files'
            && effectiveArgs.includes('--stage')
        ) {
            return this.result(0, this.options.stagedIndexEntries);
        }
        if (effectiveArgs[0] === 'ls-files') {
            return this.result();
        }
        if (
            effectiveArgs[0] === 'diff'
            && effectiveArgs.includes('--binary')
        ) {
            return this.result(0, this.options.patch);
        }
        if (joined === 'rev-parse HEAD') {
            return this.result(
                0,
                `${this.commitCreated ? COMMIT_SHA : BASE_SHA}\n`,
            );
        }
        if (
            joined
            === `ls-remote --heads origin refs/heads/main`
        ) {
            const sequence = this.options.mainShaSequence;
            const mainSha = sequence.length === 0
                ? this.options.mainSha
                : sequence[
                    Math.min(this.mainLookupCount, sequence.length - 1)
                ];
            this.mainLookupCount += 1;
            return this.result(
                0,
                `${mainSha}\trefs/heads/main\n`,
            );
        }
        if (joined === 'rev-parse refs/remotes/origin/main') {
            return this.result(0, `${this.options.mainSha}\n`);
        }
        if (
            joined
            === `ls-remote --heads origin refs/heads/${AUTOMATION_BRANCH}`
        ) {
            const sequence = this.options.remoteBranchShaSequence;
            if (!this.pushed && this.remoteBranchLookupCount < sequence.length) {
                this.remoteBranchCurrentSha =
                    sequence[this.remoteBranchLookupCount];
            }
            this.remoteBranchLookupCount += 1;
            const sha = this.pushed ? COMMIT_SHA : this.remoteBranchCurrentSha;
            return this.result(
                0,
                sha
                    ? `${sha}\trefs/heads/${AUTOMATION_BRANCH}\n`
                    : '',
            );
        }
        if (
            joined
            === `rev-parse refs/remotes/origin/${AUTOMATION_BRANCH}`
        ) {
            return this.result(0, `${this.remoteBranchCurrentSha}\n`);
        }
        if (
            effectiveArgs[0] === 'show'
            && effectiveArgs.includes('--format=%B')
        ) {
            return this.result(0, this.options.remoteTrailer);
        }
        if (
            joined === 'diff --cached --quiet -- pre-publish'
        ) {
            return this.result(this.options.changed ? 1 : 0);
        }
        if (effectiveArgs[0] === 'commit') {
            this.commitCreated = true;
            return this.result();
        }
        if (effectiveArgs[0] === 'push') {
            const deleteRefspec =
                `:refs/heads/${AUTOMATION_BRANCH}`;
            if (effectiveArgs.includes(deleteRefspec)) {
                const leasePrefix =
                    `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:`;
                const lease = effectiveArgs.find((arg) =>
                    arg.startsWith(leasePrefix),
                );
                const expectedSha = lease?.slice(leasePrefix.length);
                if (
                    !expectedSha
                    || this.remoteBranchCurrentSha !== expectedSha
                ) {
                    return this.result(1, '', 'stale info');
                }
                this.remoteBranchCurrentSha = null;
                return this.result();
            }
            this.pushed = true;
            this.remoteBranchCurrentSha = COMMIT_SHA;
            return this.result();
        }
        return this.result();
    };
}

test('CLI strictly scopes all target modes and never accepts a token option', () => {
    assert.deepEqual(
        parseCliArgs([
            'prepare',
            '--target',
            'qiita',
            '--source-root',
            'snapshot',
            '--repository-root',
            'target',
        ]),
        {
            mode: 'prepare',
            target: 'qiita',
            sourceRoot: path.resolve('snapshot'),
            repositoryRoot: path.resolve('target'),
        },
    );
    assert.deepEqual(
        parseCliArgs([
            'export',
            '--target',
            'qiita',
            '--repository-root',
            'target',
            '--output',
            'prepared.json',
        ]),
        {
            mode: 'export',
            target: 'qiita',
            repositoryRoot: path.resolve('target'),
            output: path.resolve('prepared.json'),
        },
    );
    assert.deepEqual(
        parseCliArgs([
            'apply',
            '--target',
            'zenn',
            '--repository-root',
            'target',
            '--patch-file',
            'prepared.json',
        ]),
        {
            mode: 'apply',
            target: 'zenn',
            repositoryRoot: path.resolve('target'),
            patchFile: path.resolve('prepared.json'),
        },
    );
    assert.deepEqual(
        parseCliArgs([
            'publish',
            '--target',
            'zenn',
            '--repository-root',
            'target',
        ]),
        {
            mode: 'publish',
            target: 'zenn',
            repositoryRoot: path.resolve('target'),
        },
    );
    assert.throws(
        () =>
            parseCliArgs([
                'publish',
                '--target',
                'other',
                '--repository-root',
                'target',
            ]),
        /unsupported distribution target/,
    );
    assert.throws(
        () =>
            parseCliArgs([
                'publish',
                '--target',
                'qiita',
                '--repository-root',
                'target',
                '--gh-token',
                TOKEN,
            ]),
        /unknown option/,
    );
    assert.throws(
        () =>
            parseCliArgs([
                'export',
                '--target',
                'qiita',
                '--repository-root',
                'target',
                '--patch-file',
                'prepared.json',
            ]),
        /--output is required/,
    );
    assert.throws(
        () =>
            parseCliArgs([
                'apply',
                '--target',
                'qiita',
                '--repository-root',
                'target',
                '--patch-file',
                'prepared.json',
                '--output',
                'other.json',
            ]),
        /not valid for apply/,
    );
});

test('publish metadata is read only from strict GitHub environment values', () => {
    const result = loadPublishMetadata(publishEnvironment());
    assert.equal(result.token, TOKEN);
    assert.equal(result.sourceSha, 'a'.repeat(40));
    assert.equal(
        result.sourceTimestamp,
        '2026-07-24T10:00:00+08:00',
    );

    assert.throws(
        () =>
            loadPublishMetadata({
                ...publishEnvironment(),
                DISTRIBUTION_SOURCE_TIMESTAMP: '2026-07-24',
            }),
        /strict ISO 8601/,
    );
    assert.throws(
        () =>
            loadPublishMetadata({
                ...publishEnvironment(),
                GITHUB_REPOSITORY: 'someone/else',
            }),
        /GITHUB_REPOSITORY/,
    );
});

test('export writes a bounded token-free envelope from the exact staged paths', () => {
    const temporaryRoot = makeDirectory();
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    const output = path.join(temporaryRoot, 'prepared-target.json');
    fs.mkdirSync(repositoryRoot);
    writeFile(repositoryRoot, 'pre-publish/a.md', 'prepared\n');
    const patch =
        'diff --git a/pre-publish/a.md b/pre-publish/a.md\n'
        + `index ${'4'.repeat(40)}..${'5'.repeat(40)} 100644\n`
        + '--- a/pre-publish/a.md\n'
        + '+++ b/pre-publish/a.md\n'
        + '@@ -1 +1 @@\n-old\n+prepared\n';
    try {
        const fake = new FakeRunner(repositoryRoot, { patch });
        const result = exportTarget(
            {
                mode: 'export',
                target: 'qiita',
                repositoryRoot,
                output,
            },
            {
                env: {
                    GH_TOKEN: TOKEN,
                    GITHUB_SHA: 'a'.repeat(40),
                },
                runner: fake.run,
            },
        );
        assert.equal(result.baseSha, BASE_SHA);
        assert.equal(result.output, output);
        assert.ok(result.bytes > 0);
        assert.ok(result.bytes <= MAX_ENVELOPE_BYTES);
        const serialized = fs.readFileSync(output, 'utf8');
        assert.equal(Buffer.byteLength(serialized), result.bytes);
        assert.deepEqual(JSON.parse(serialized), {
            schema: 1,
            target: 'qiita',
            repository: 'SolitudeRA/Qiita-Repo',
            baseSha: BASE_SHA,
            sourceSha: 'a'.repeat(40),
            patch,
        });
        assert.ok(
            fake.calls.some(
                (call) =>
                    call.command === 'git'
                    && call.args[0] === 'add'
                    && call.args.includes('pre-publish'),
            ),
        );
        assert.ok(
            fake.calls.some(
                (call) =>
                    call.command === 'git'
                    && call.args[0] === 'diff'
                    && call.args.includes('--binary')
                    && call.args.includes('--full-index'),
            ),
        );
        assert.ok(fake.calls.every((call) => call.command === 'git'));
        assert.ok(
            fake.calls.every(
                (call) => call.options.env?.GH_TOKEN === undefined,
            ),
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('apply validates provenance before a binary index apply and runs only Git', () => {
    const temporaryRoot = makeDirectory();
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    const patchFile = path.join(temporaryRoot, 'prepared-target.json');
    fs.mkdirSync(repositoryRoot);
    writeFile(repositoryRoot, 'pre-publish/a.md', 'old\n');
    fs.writeFileSync(
        patchFile,
        `${JSON.stringify(distributionEnvelope())}\n`,
        'utf8',
    );
    try {
        const fake = new FakeRunner(repositoryRoot);
        const result = applyTarget(
            {
                mode: 'apply',
                target: 'qiita',
                repositoryRoot,
                patchFile,
            },
            {
                env: { GITHUB_SHA: 'a'.repeat(40) },
                runner: fake.run,
            },
        );
        assert.deepEqual(result, {
            baseSha: BASE_SHA,
            branch: AUTOMATION_BRANCH,
            changed: true,
        });
        const apply = fake.calls.find(
            (call) =>
                call.command === 'git'
                && call.args[0] === 'apply',
        );
        assert.ok(apply);
        assert.deepEqual(apply.args.slice(0, 4), [
            'apply',
            '--index',
            '--binary',
            '--whitespace=error-all',
        ]);
        assert.ok(
            fake.calls.some(
                (call) =>
                    call.command === 'git'
                    && call.args.join(' ')
                        === 'fetch --no-tags origin '
                        + '+refs/heads/main:refs/remotes/origin/main',
            ),
        );
        assert.ok(fake.calls.every((call) => call.command === 'git'));
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('export and apply reject gitlinks stored only in the Git index', () => {
    for (const mode of ['export', 'apply'] as const) {
        const temporaryRoot = makeDirectory();
        const repositoryRoot = path.join(temporaryRoot, 'repository');
        const envelopePath = path.join(temporaryRoot, 'prepared-target.json');
        fs.mkdirSync(repositoryRoot);
        writeFile(repositoryRoot, 'pre-publish/a.md', 'old\n');
        const fake = new FakeRunner(repositoryRoot, {
            stagedIndexEntries:
                `160000 ${'4'.repeat(40)} 0\tpre-publish/gitlink\0`,
        });
        try {
            if (mode === 'export') {
                assert.throws(
                    () =>
                        exportTarget(
                            {
                                mode,
                                target: 'qiita',
                                repositoryRoot,
                                output: envelopePath,
                            },
                            {
                                env: { GITHUB_SHA: 'a'.repeat(40) },
                                runner: fake.run,
                            },
                        ),
                    /must be a regular file/,
                );
                assert.equal(fs.existsSync(envelopePath), false);
            } else {
                fs.writeFileSync(
                    envelopePath,
                    `${JSON.stringify(distributionEnvelope())}\n`,
                    'utf8',
                );
                assert.throws(
                    () =>
                        applyTarget(
                            {
                                mode,
                                target: 'qiita',
                                repositoryRoot,
                                patchFile: envelopePath,
                            },
                            {
                                env: { GITHUB_SHA: 'a'.repeat(40) },
                                runner: fake.run,
                            },
                        ),
                    /must be a regular file/,
                );
            }
        } finally {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
    }
});

test('apply rejects tampered target, source, base, and outside paths', () => {
    const cases: Array<{
        envelope: Record<string, unknown>;
        expected: RegExp;
        fake?: FakeRunnerOptions;
    }> = [
        {
            envelope: distributionEnvelope({
                target: 'zenn',
                repository: 'SolitudeRA/Zenn-Repo',
            }),
            expected: /target does not match/,
        },
        {
            envelope: distributionEnvelope({ sourceSha: 'b'.repeat(40) }),
            expected: /source SHA does not match/,
        },
        {
            envelope: distributionEnvelope({ baseSha: '9'.repeat(40) }),
            expected: /base SHA/,
        },
        {
            envelope: distributionEnvelope(),
            fake: { outsidePath: 'README.md' },
            expected: /outside its allowlist/,
        },
    ];

    for (const item of cases) {
        const temporaryRoot = makeDirectory();
        const repositoryRoot = path.join(temporaryRoot, 'repository');
        const patchFile = path.join(temporaryRoot, 'prepared-target.json');
        fs.mkdirSync(repositoryRoot);
        writeFile(repositoryRoot, 'pre-publish/a.md', 'old\n');
        fs.writeFileSync(
            patchFile,
            `${JSON.stringify(item.envelope)}\n`,
            'utf8',
        );
        try {
            const fake = new FakeRunner(repositoryRoot, item.fake);
            assert.throws(
                () =>
                    applyTarget(
                        {
                            mode: 'apply',
                            target: 'qiita',
                            repositoryRoot,
                            patchFile,
                        },
                        {
                            env: { GITHUB_SHA: 'a'.repeat(40) },
                            runner: fake.run,
                        },
                    ),
                item.expected,
            );
            assert.ok(fake.calls.every((call) => call.command === 'git'));
        } finally {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
    }
});

test('apply rejects non-regular and oversized envelopes before commands', () => {
    const temporaryRoot = makeDirectory();
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    const envelopeDirectory = path.join(temporaryRoot, 'envelope-directory');
    const oversized = path.join(temporaryRoot, 'oversized.json');
    fs.mkdirSync(repositoryRoot);
    fs.mkdirSync(envelopeDirectory);
    const descriptor = fs.openSync(oversized, 'w');
    fs.ftruncateSync(descriptor, MAX_ENVELOPE_BYTES + 1);
    fs.closeSync(descriptor);
    try {
        for (const patchFile of [envelopeDirectory, oversized]) {
            const fake = new FakeRunner(repositoryRoot);
            assert.throws(
                () =>
                    applyTarget(
                        {
                            mode: 'apply',
                            target: 'qiita',
                            repositoryRoot,
                            patchFile,
                        },
                        {
                            env: { GITHUB_SHA: 'a'.repeat(40) },
                            runner: fake.run,
                        },
                    ),
                /regular file|between 1 and/,
            );
            assert.equal(fake.calls.length, 0);
        }
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('prepare snapshot exactly replaces stale entries and overlays no collisions', () => {
    const temporaryRoot = makeDirectory();
    const sourceRoot = path.join(temporaryRoot, 'source');
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(repositoryRoot);
    writeFile(sourceRoot, 'share/a.md', 'shared');
    writeFile(sourceRoot, 'qiita/b.md', 'qiita');
    writeFile(sourceRoot, 'manifest.json', '{"schema_version":1}\n');
    writeFile(repositoryRoot, 'pre-publish/stale.md', 'stale');
    writeFile(repositoryRoot, 'pre-publish/.stale', 'stale-hidden');

    try {
        const copied = rebuildPrePublish(
            sourceRoot,
            repositoryRoot,
            'qiita',
        );
        assert.deepEqual(copied, ['a.md', 'b.md', 'manifest.json']);
        assert.equal(
            fs.readFileSync(
                path.join(repositoryRoot, 'pre-publish/a.md'),
                'utf8',
            ),
            'shared',
        );
        assert.equal(
            fs.readFileSync(
                path.join(repositoryRoot, 'pre-publish/b.md'),
                'utf8',
            ),
            'qiita',
        );
        assert.equal(
            fs.existsSync(
                path.join(repositoryRoot, 'pre-publish/stale.md'),
            ),
            false,
        );
        assert.equal(
            fs.existsSync(path.join(repositoryRoot, 'pre-publish/.stale')),
            false,
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('prepare snapshot accepts a restored empty shared directory', () => {
    const temporaryRoot = makeDirectory();
    const sourceRoot = path.join(temporaryRoot, 'source');
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    fs.mkdirSync(path.join(sourceRoot, 'share'), { recursive: true });
    fs.mkdirSync(repositoryRoot);
    writeFile(sourceRoot, 'qiita/platform-only.md', 'platform');
    writeFile(sourceRoot, 'manifest.json', '{"schema_version":1}\n');
    writeFile(repositoryRoot, 'pre-publish/stale.md', 'stale');

    try {
        const copied = rebuildPrePublish(
            sourceRoot,
            repositoryRoot,
            'qiita',
        );
        assert.deepEqual(copied, ['manifest.json', 'platform-only.md']);
        assert.equal(
            fs.readFileSync(
                path.join(repositoryRoot, 'pre-publish/platform-only.md'),
                'utf8',
            ),
            'platform',
        );
        assert.equal(
            fs.existsSync(path.join(repositoryRoot, 'pre-publish/stale.md')),
            false,
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('prepare starts from checked-out main and switches to the fixed branch', () => {
    const temporaryRoot = makeDirectory();
    const sourceRoot = path.join(temporaryRoot, 'source');
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(repositoryRoot);
    writeFile(sourceRoot, 'share/a.md', 'shared');
    writeFile(sourceRoot, 'manifest.json', '{}\n');
    const calls: RecordedCall[] = [];
    const runner: CommandRunner = (command, args, options) => {
        calls.push({ command, args: [...args], options });
        const joined = args.join(' ');
        if (joined === 'rev-parse --show-toplevel') {
            return { status: 0, stdout: `${repositoryRoot}\n`, stderr: '' };
        }
        if (joined === 'remote get-url origin') {
            return {
                status: 0,
                stdout: 'https://github.com/SolitudeRA/Qiita-Repo.git\n',
                stderr: '',
            };
        }
        if (args[0] === 'status') {
            return { status: 0, stdout: '', stderr: '' };
        }
        if (joined === 'rev-parse HEAD') {
            return { status: 0, stdout: `${BASE_SHA}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };

    try {
        const result = prepareTarget(
            {
                mode: 'prepare',
                target: 'qiita',
                sourceRoot,
                repositoryRoot,
            },
            { runner },
        );
        assert.equal(result.baseSha, BASE_SHA);
        assert.equal(result.branch, AUTOMATION_BRANCH);
        assert.ok(
            calls.some(
                (call) =>
                    call.command === 'git'
                    && call.args.join(' ')
                        === `checkout -B ${AUTOMATION_BRANCH} ${BASE_SHA}`,
            ),
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('snapshot preparation rejects symlinks and shared/platform collisions', (t) => {
    const temporaryRoot = makeDirectory();
    const sourceRoot = path.join(temporaryRoot, 'source');
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(repositoryRoot);
    writeFile(sourceRoot, 'share/a.md', 'shared');
    writeFile(sourceRoot, 'manifest.json', '{}\n');
    fs.mkdirSync(path.join(sourceRoot, 'qiita'));

    try {
        try {
            fs.symlinkSync(
                path.join(sourceRoot, 'share/a.md'),
                path.join(sourceRoot, 'qiita/link.md'),
                'file',
            );
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code && ['EPERM', 'EACCES', 'ENOTSUP'].includes(code)) {
                t.skip(`symlink creation is unavailable: ${code}`);
                return;
            }
            throw error;
        }
        assert.throws(
            () =>
                rebuildPrePublish(sourceRoot, repositoryRoot, 'qiita'),
            /symbolic links are not allowed/,
        );
        fs.rmSync(path.join(sourceRoot, 'qiita/link.md'));
        writeFile(sourceRoot, 'qiita/a.md', 'collision');
        assert.throws(
            () =>
                rebuildPrePublish(sourceRoot, repositoryRoot, 'qiita'),
            /collide/,
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('required-check policy requires strict GitHub Actions integration binding', () => {
    const config = {
        allowedPaths: ['pre-publish'],
        target: 'qiita' as const,
        repository: 'SolitudeRA/Qiita-Repo',
        requiredCheck: 'validate_and_publish',
    };
    assert.equal(
        rulesetRequiredCheckIsValid(
            [
                {
                    type: 'required_status_checks',
                    parameters: {
                        strict_required_status_checks_policy: true,
                        required_status_checks: [
                            {
                                context: 'validate_and_publish',
                                integration_id: 15368,
                            },
                        ],
                    },
                },
            ],
            config,
        ),
        true,
    );
    assert.equal(
        rulesetRequiredCheckIsValid(
            [
                {
                    type: 'required_status_checks',
                    parameters: {
                        strict_required_status_checks_policy: true,
                        required_status_checks: [
                            {
                                context: 'validate_and_publish',
                                integration_id: null,
                            },
                        ],
                    },
                },
            ],
            config,
        ),
        false,
    );
});

test('repository policy requires auto-merge, rebase, and branch deletion', () => {
    const config = {
        allowedPaths: ['pre-publish'],
        target: 'qiita' as const,
        repository: 'SolitudeRA/Qiita-Repo',
        requiredCheck: 'validate_and_publish',
    };
    assert.doesNotThrow(() =>
        validateRepositoryPolicyPayload(
            {
                full_name: 'SolitudeRA/Qiita-Repo',
                default_branch: 'main',
                allow_auto_merge: true,
                allow_rebase_merge: true,
                delete_branch_on_merge: true,
            },
            config,
        ),
    );
    assert.throws(
        () =>
            validateRepositoryPolicyPayload(
                {
                    full_name: 'SolitudeRA/Qiita-Repo',
                    default_branch: 'main',
                    allow_auto_merge: true,
                    allow_rebase_merge: true,
                    delete_branch_on_merge: false,
                },
                config,
            ),
        /delete_branch_on_merge/,
    );
});

test('target path allowlists keep Qiita narrow and include Zenn generated outputs', () => {
    const changedPaths = [
        'pre-publish/a.md',
        'articles/a.md',
        'article-map.json',
    ];
    const runner: CommandRunner = () => ({
        status: 0,
        stdout: `${changedPaths.join('\0')}\0`,
        stderr: '',
    });
    assert.doesNotThrow(() =>
        assertOnlyAllowedChanges(runner, process.cwd(), TARGETS.zenn),
    );
    assert.throws(
        () =>
            assertOnlyAllowedChanges(
                runner,
                process.cwd(),
                TARGETS.qiita,
            ),
        /outside its allowlist/,
    );
});

test('automation trailer is fail-closed', () => {
    assert.doesNotThrow(() =>
        assertAutomationTrailer(
            [
                'subject',
                '',
                'Automated-By: Blog-Project',
                `Distribution-Source: SolitudeRA/Blog-Project@${'a'.repeat(40)}`,
            ].join('\n'),
        ),
    );
    assert.throws(
        () => assertAutomationTrailer('subject\n'),
        /not owned/,
    );
    assert.throws(
        () =>
            assertAutomationTrailer(
                'Automated-By: Blog-Project\nDistribution-Source: other/repo@abc',
            ),
        /invalid source trailer/,
    );
});

test('publish uses an exact lease and arms ready PR auto-merge without token argv', () => {
    const root = makeDirectory();
    try {
        const fake = new FakeRunner(root);
        const result = publishTarget(
            {
                mode: 'publish',
                target: 'qiita',
                repositoryRoot: root,
            },
            {
                env: publishEnvironment(),
                runner: fake.run,
            },
        );
        assert.equal(result.action, 'published');
        assert.equal(result.commitSha, COMMIT_SHA);

        const push = fake.calls.find(
            (call) =>
                call.command === 'git'
                && call.args.includes('push'),
        );
        assert.ok(push);
        assert.ok(
            push.args.includes(
                `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:${REMOTE_SHA}`,
            ),
        );
        assert.equal(push.args.includes('--force'), false);

        const commit = fake.calls.find(
            (call) => call.command === 'git' && call.args[0] === 'commit',
        );
        assert.ok(commit);
        assert.equal(commit.options.env?.GIT_AUTHOR_NAME, 'github-actions[bot]');
        assert.equal(
            commit.options.env?.GIT_AUTHOR_DATE,
            '2026-07-24T10:00:00+08:00',
        );
        assert.match(commit.args.join('\n'), /Automated-By: Blog-Project/);

        const merge = fake.calls.find(
            (call) =>
                call.command === 'gh'
                && call.args[0] === 'pr'
                && call.args[1] === 'merge'
                && call.args.includes('--auto'),
        );
        assert.ok(merge);
        assert.ok(merge.args.includes('--rebase'));
        assert.ok(merge.args.includes('--match-head-commit'));
        assert.ok(merge.args.includes(COMMIT_SHA));
        assert.equal(merge.args.includes('--admin'), false);

        for (const call of fake.calls) {
            assert.equal(call.args.some((arg) => arg.includes(TOKEN)), false);
            if (call.command === 'gh') {
                assert.equal(call.options.env?.GH_TOKEN, TOKEN);
            }
        }
        const networkGitCalls = fake.calls.filter(
            (call) =>
                call.command === 'git'
                && call.args[0] === '-c'
                && call.args[1]
                    === 'credential.helper=!gh auth git-credential',
        );
        assert.ok(networkGitCalls.length > 0);
        assert.ok(
            networkGitCalls.every(
                (call) => call.options.env?.GH_TOKEN === TOKEN,
            ),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('publish preserves verified REBASE auto-merge and rejects another method', () => {
    const root = makeDirectory();
    try {
        const alreadyEnabled = new FakeRunner(root, {
            autoMergeRequest: { mergeMethod: 'REBASE' },
        });
        assert.equal(
            publishTarget(
                {
                    mode: 'publish',
                    target: 'qiita',
                    repositoryRoot: root,
                },
                {
                    env: publishEnvironment(),
                    runner: alreadyEnabled.run,
                },
            ).action,
            'published',
        );
        assert.equal(
            alreadyEnabled.calls.some(
                (call) =>
                    call.command === 'gh'
                    && call.args[0] === 'pr'
                    && call.args[1] === 'merge'
                    && call.args.includes('--auto'),
            ),
            false,
        );

        const wrongMethod = new FakeRunner(root, {
            autoMergeRequest: { mergeMethod: 'SQUASH' },
        });
        assert.throws(
            () =>
                publishTarget(
                    {
                        mode: 'publish',
                        target: 'qiita',
                        repositoryRoot: root,
                    },
                    {
                        env: publishEnvironment(),
                        runner: wrongMethod.run,
                    },
                ),
            /must use the REBASE method/,
        );
        assert.equal(wrongMethod.commitCreated, false);
        assert.equal(wrongMethod.pushed, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a new automation branch uses an exact empty lease and creates one ready PR', () => {
    const root = makeDirectory();
    try {
        const fake = new FakeRunner(root, {
            openPullRequest: false,
            remoteBranchSha: null,
        });
        const result = publishTarget(
            {
                mode: 'publish',
                target: 'qiita',
                repositoryRoot: root,
            },
            { env: publishEnvironment(), runner: fake.run },
        );
        assert.equal(result.action, 'published');
        assert.equal(fake.prCreated, true);
        const push = fake.calls.find(
            (call) =>
                call.command === 'git'
                && call.args.includes('push'),
        );
        assert.ok(push);
        assert.ok(
            push.args.includes(
                `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:`,
            ),
        );
        assert.ok(
            fake.calls.some(
                (call) =>
                    call.command === 'gh'
                    && call.args[0] === 'pr'
                    && call.args[1] === 'create',
            ),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('no diff is a pure no-op, while an exact stale PR is disabled and closed', () => {
    const root = makeDirectory();
    try {
        const noPr = new FakeRunner(root, {
            changed: false,
            openPullRequest: false,
            remoteBranchSha: null,
        });
        assert.equal(
            publishTarget(
                {
                    mode: 'publish',
                    target: 'qiita',
                    repositoryRoot: root,
                },
                { env: publishEnvironment(), runner: noPr.run },
            ).action,
            'no-op',
        );
        assert.equal(
            noPr.calls.some(
                (call) =>
                    call.args[0] === 'push'
                    || (call.command === 'gh'
                        && call.args[0] === 'pr'
                        && ['create', 'merge', 'close'].includes(
                            String(call.args[1]),
                        )),
            ),
            false,
        );

        const stalePr = new FakeRunner(root, {
            autoMergeRequest: { mergeMethod: 'REBASE' },
            changed: false,
        });
        assert.equal(
            publishTarget(
                {
                    mode: 'publish',
                    target: 'qiita',
                    repositoryRoot: root,
                },
                { env: publishEnvironment(), runner: stalePr.run },
            ).action,
            'closed-stale-pr',
        );
        const disable = stalePr.calls.find(
            (call) =>
                call.command === 'gh'
                && call.args.includes('--disable-auto'),
        );
        const close = stalePr.calls.find(
            (call) =>
                call.command === 'gh'
                && call.args[0] === 'pr'
                && call.args[1] === 'close',
        );
        assert.ok(disable);
        assert.ok(close);
        assert.equal(close.args.includes('--delete-branch'), false);
        const deletePush = stalePr.calls.find(
            (call) =>
                call.command === 'git'
                && call.args.includes(
                    `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:${REMOTE_SHA}`,
                )
                && call.args.includes(`:refs/heads/${AUTOMATION_BRANCH}`),
        );
        assert.ok(deletePush);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('no-diff reconciliation fails closed when main advances during PR cleanup', () => {
    const root = makeDirectory();
    try {
        const beforeNoOp = new FakeRunner(root, {
            changed: false,
            mainShaSequence: [BASE_SHA, '9'.repeat(40)],
            openPullRequest: false,
            remoteBranchSha: null,
        });
        assert.throws(
            () =>
                publishTarget(
                    {
                        mode: 'publish',
                        target: 'qiita',
                        repositoryRoot: root,
                    },
                    {
                        env: publishEnvironment(),
                        runner: beforeNoOp.run,
                    },
                ),
            /before resolving a no-diff distribution/,
        );

        const beforeClose = new FakeRunner(root, {
            autoMergeRequest: { mergeMethod: 'REBASE' },
            changed: false,
            mainShaSequence: [
                BASE_SHA,
                BASE_SHA,
                '9'.repeat(40),
            ],
        });
        assert.throws(
            () =>
                publishTarget(
                    {
                        mode: 'publish',
                        target: 'qiita',
                        repositoryRoot: root,
                    },
                    {
                        env: publishEnvironment(),
                        runner: beforeClose.run,
                    },
                ),
            /after stale auto-merge was disabled/,
        );
        assert.ok(
            beforeClose.calls.some(
                (call) =>
                    call.command === 'gh'
                    && call.args.includes('--disable-auto'),
            ),
        );
        assert.equal(
            beforeClose.calls.some(
                (call) =>
                    call.command === 'gh'
                    && call.args[0] === 'pr'
                    && call.args[1] === 'close',
            ),
            false,
        );

        const afterClose = new FakeRunner(root, {
            autoMergeRequest: { mergeMethod: 'REBASE' },
            changed: false,
            mainShaSequence: [
                BASE_SHA,
                BASE_SHA,
                BASE_SHA,
                '9'.repeat(40),
            ],
        });
        assert.throws(
            () =>
                publishTarget(
                    {
                        mode: 'publish',
                        target: 'qiita',
                        repositoryRoot: root,
                    },
                    {
                        env: publishEnvironment(),
                        runner: afterClose.run,
                    },
                ),
            /after the stale distribution pull request was closed/,
        );
        assert.ok(
            afterClose.calls.some(
                (call) =>
                    call.command === 'gh'
                    && call.args[0] === 'pr'
                    && call.args[1] === 'close',
            ),
        );

        const branchAdvanced = new FakeRunner(root, {
            autoMergeRequest: { mergeMethod: 'REBASE' },
            changed: false,
            remoteBranchShaSequence: [REMOTE_SHA, '8'.repeat(40)],
        });
        assert.throws(
            () =>
                publishTarget(
                    {
                        mode: 'publish',
                        target: 'qiita',
                        repositoryRoot: root,
                    },
                    {
                        env: publishEnvironment(),
                        runner: branchAdvanced.run,
                    },
                ),
            /changed during stale cleanup; refusing to delete/,
        );
        assert.ok(
            branchAdvanced.calls.some(
                (call) =>
                    call.command === 'gh'
                    && call.args[0] === 'pr'
                    && call.args[1] === 'close',
            ),
        );
        assert.equal(
            branchAdvanced.calls.some(
                (call) =>
                    call.command === 'git'
                    && call.args.includes(
                        `:refs/heads/${AUTOMATION_BRANCH}`,
                    ),
            ),
            false,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('publish fails before mutation for policy, path, main, and trailer violations', () => {
    const cases: Array<{
        expected: RegExp;
        options: FakeRunnerOptions;
    }> = [
        {
            options: {
                rulesPolicy: [],
            },
            expected: /must strictly require/,
        },
        {
            options: { outsidePath: 'README.md' },
            expected: /outside its allowlist/,
        },
        {
            options: { mainSha: '9'.repeat(40) },
            expected: /origin\/main changed/,
        },
        {
            options: { remoteTrailer: 'manual branch\n' },
            expected: /not owned/,
        },
    ];

    for (const item of cases) {
        const root = makeDirectory();
        try {
            const fake = new FakeRunner(root, item.options);
            assert.throws(
                () =>
                    publishTarget(
                        {
                            mode: 'publish',
                            target: 'qiita',
                            repositoryRoot: root,
                        },
                        {
                            env: publishEnvironment(),
                            runner: fake.run,
                        },
                    ),
                item.expected,
            );
            assert.equal(fake.commitCreated, false);
            assert.equal(fake.pushed, false);
            assert.equal(
                fake.calls.some(
                    (call) =>
                        call.command === 'gh'
                        && call.args.includes('--auto'),
                ),
                false,
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('commit metadata is stable for the same source run', () => {
    const first = buildCommitMessage(metadata());
    const second = buildCommitMessage(metadata());
    assert.equal(first, second);
    assert.match(
        first,
        new RegExp(
            `Distribution-Source: SolitudeRA/Blog-Project@${'a'.repeat(40)}`,
        ),
    );
});
