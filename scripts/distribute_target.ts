'use strict';

const childProcess: typeof import('node:child_process') =
    require('node:child_process');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');

export type DistributionTarget = 'qiita' | 'zenn';
export type DistributionMode = 'apply' | 'export' | 'prepare' | 'publish';

export interface TargetConfig {
    allowedPaths: readonly string[];
    target: DistributionTarget;
    repository: string;
    requiredCheck: string;
}

export interface PrepareOptions {
    mode: 'prepare';
    target: DistributionTarget;
    sourceRoot: string;
    repositoryRoot: string;
}

export interface PublishOptions {
    mode: 'publish';
    target: DistributionTarget;
    repositoryRoot: string;
}

export interface ExportOptions {
    mode: 'export';
    target: DistributionTarget;
    repositoryRoot: string;
    output: string;
}

export interface ApplyOptions {
    mode: 'apply';
    target: DistributionTarget;
    repositoryRoot: string;
    patchFile: string;
}

export type CliOptions =
    | ApplyOptions
    | ExportOptions
    | PrepareOptions
    | PublishOptions;

export interface CommandOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
    error?: Error;
    status: number | null;
    stdout: string;
    stderr: string;
}

export type CommandRunner = (
    command: string,
    args: readonly string[],
    options: CommandOptions,
) => CommandResult;

export interface RuntimeDependencies {
    env?: NodeJS.ProcessEnv;
    runner?: CommandRunner;
}

export interface PublishMetadata {
    token: string;
    sourceSha: string;
    sourceTimestamp: string;
    sourceRepository: string;
    serverUrl: string;
    runId: string;
    runAttempt: string;
}

export interface PullRequestInfo {
    autoMergeRequest: {
        mergeMethod: 'REBASE';
    } | null;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    headRepositoryOwner: {
        login: string;
    };
    isDraft: boolean;
    number: number;
    url: string;
}

export interface PrepareResult {
    baseSha: string;
    branch: string;
    copiedFiles: string[];
}

export interface PublishResult {
    action: 'closed-stale-pr' | 'no-op' | 'published';
    branch: string;
    commitSha?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
}

export interface DistributionEnvelope {
    schema: 1;
    target: DistributionTarget;
    repository: string;
    baseSha: string;
    sourceSha: string;
    patch: string;
}

export interface ExportResult {
    baseSha: string;
    bytes: number;
    output: string;
}

export interface ApplyResult {
    baseSha: string;
    branch: string;
    changed: boolean;
}

const AUTOMATION_BRANCH = 'automation/blog-project-distribution';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL =
    '41898282+github-actions[bot]@users.noreply.github.com';
const EXPECTED_INTEGRATION_ID = 15368;
const SOURCE_REPOSITORY = 'SolitudeRA/Blog-Project';
const SOURCE_TRAILER = 'Automated-By: Blog-Project';
const ENVELOPE_SCHEMA = 1;
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 15 * 1024 * 1024;
const COMMAND_MAX_BUFFER_BYTES = MAX_ENVELOPE_BYTES + 1024 * 1024;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const STRICT_ISO_TIMESTAMP =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const TARGETS: Readonly<Record<DistributionTarget, TargetConfig>> = {
    qiita: {
        allowedPaths: ['pre-publish'],
        target: 'qiita',
        repository: 'SolitudeRA/Qiita-Repo',
        requiredCheck: 'validate_and_publish',
    },
    zenn: {
        allowedPaths: ['pre-publish', 'articles', 'article-map.json'],
        target: 'zenn',
        repository: 'SolitudeRA/Zenn-Repo',
        requiredCheck: 'validate_pull_request',
    },
};

function defaultCommandRunner(
    command: string,
    args: readonly string[],
    options: CommandOptions,
): CommandResult {
    const result = childProcess.spawnSync(command, [...args], {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env || process.env,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    return {
        error: result.error,
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
}

function redact(value: string, secrets: readonly (string | undefined)[]): string {
    let result = value;
    for (const secret of secrets) {
        if (secret) {
            result = result.split(secret).join('[REDACTED]');
        }
    }
    return result;
}

function runChecked(
    runner: CommandRunner,
    command: string,
    args: readonly string[],
    options: CommandOptions,
    operation: string,
): string {
    const result = runner(command, args, options);
    const secrets = [options.env?.GH_TOKEN];
    if (result.error) {
        throw new Error(
            `${operation} could not start: ${redact(result.error.message, secrets)}`,
        );
    }
    if (result.status !== 0) {
        const detail = redact(
            String(result.stderr || result.stdout || '').trim(),
            secrets,
        );
        throw new Error(`${operation} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
}

function runGit(
    runner: CommandRunner,
    repositoryRoot: string,
    args: readonly string[],
    operation: string,
    env?: NodeJS.ProcessEnv,
): string {
    return runChecked(
        runner,
        'git',
        args,
        { cwd: repositoryRoot, env },
        operation,
    );
}

function runNetworkGit(
    runner: CommandRunner,
    repositoryRoot: string,
    token: string,
    args: readonly string[],
    operation: string,
): string {
    return runGit(
        runner,
        repositoryRoot,
        [
            '-c',
            'credential.helper=!gh auth git-credential',
            ...args,
        ],
        operation,
        {
            ...process.env,
            GH_TOKEN: token,
        },
    );
}

function runGh(
    runner: CommandRunner,
    repositoryRoot: string,
    token: string,
    args: readonly string[],
    operation: string,
): string {
    return runChecked(
        runner,
        'gh',
        args,
        {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                GH_TOKEN: token,
            },
        },
        operation,
    );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(output: string, operation: string): unknown {
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new Error(
            `${operation} returned invalid JSON: ${(error as Error).message}`,
        );
    }
}

function getTargetConfig(target: string): TargetConfig {
    if (target !== 'qiita' && target !== 'zenn') {
        throw new Error(`unsupported distribution target: ${target}`);
    }
    return TARGETS[target];
}

function parseCliArgs(args: readonly string[]): CliOptions {
    const mode = args[0];
    if (
        mode !== 'apply'
        && mode !== 'export'
        && mode !== 'prepare'
        && mode !== 'publish'
    ) {
        throw new Error(
            'usage: distribute_target.ts <apply|export|prepare|publish> '
            + '--target <qiita|zenn> --repository-root <path> '
            + '[--source-root <path>|--output <path>|--patch-file <path>]',
        );
    }

    const values = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (
            !name ||
            !name.startsWith('--') ||
            !value ||
            value.startsWith('--')
        ) {
            throw new Error(`invalid or missing value for ${name || '(option)'}`);
        }
        if (
            ![
                '--output',
                '--patch-file',
                '--repository-root',
                '--source-root',
                '--target',
            ].includes(name)
        ) {
            throw new Error(`unknown option: ${name}`);
        }
        if (values.has(name)) {
            throw new Error(`duplicate option: ${name}`);
        }
        values.set(name, value);
    }

    const target = getTargetConfig(values.get('--target') || '').target;
    const repositoryRoot = values.get('--repository-root');
    if (!repositoryRoot) {
        throw new Error('--repository-root is required');
    }

    const sourceRoot = values.get('--source-root');
    const output = values.get('--output');
    const patchFile = values.get('--patch-file');
    if (mode === 'prepare') {
        if (!sourceRoot) {
            throw new Error('--source-root is required for prepare');
        }
        if (output || patchFile) {
            throw new Error(
                '--output and --patch-file are not valid for prepare',
            );
        }
        return {
            mode,
            target,
            sourceRoot: path.resolve(sourceRoot),
            repositoryRoot: path.resolve(repositoryRoot),
        };
    }
    if (mode === 'export') {
        if (!output) {
            throw new Error('--output is required for export');
        }
        if (sourceRoot || patchFile) {
            throw new Error(
                '--source-root and --patch-file are not valid for export',
            );
        }
        return {
            mode,
            target,
            repositoryRoot: path.resolve(repositoryRoot),
            output: path.resolve(output),
        };
    }
    if (mode === 'apply') {
        if (!patchFile) {
            throw new Error('--patch-file is required for apply');
        }
        if (sourceRoot || output) {
            throw new Error(
                '--source-root and --output are not valid for apply',
            );
        }
        return {
            mode,
            target,
            repositoryRoot: path.resolve(repositoryRoot),
            patchFile: path.resolve(patchFile),
        };
    }
    if (sourceRoot || output || patchFile) {
        throw new Error(
            '--source-root, --output, and --patch-file are not valid for publish',
        );
    }
    return {
        mode,
        target,
        repositoryRoot: path.resolve(repositoryRoot),
    };
}

function requireDirectory(candidate: string, label: string): string {
    let stat: import('node:fs').Stats;
    try {
        stat = fs.lstatSync(candidate);
    } catch (error) {
        throw new Error(
            `${label} cannot be inspected: ${(error as Error).message}`,
        );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${label} must be a real directory: ${candidate}`);
    }
    return fs.realpathSync(candidate);
}

function isPathInside(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`)
            && relative !== '..'
            && !path.isAbsolute(relative))
    );
}

function assertPathInside(
    parent: string,
    candidate: string,
    label: string,
): void {
    if (!isPathInside(parent, candidate)) {
        throw new Error(`${label} escapes its expected root: ${candidate}`);
    }
}

function assertDisjointRoots(left: string, right: string): void {
    if (isPathInside(left, right) || isPathInside(right, left)) {
        throw new Error(
            `source and repository roots must not overlap: ${left} / ${right}`,
        );
    }
}

function inspectExistingTree(candidate: string, root: string): void {
    const stat = fs.lstatSync(candidate);
    assertPathInside(root, candidate, 'Existing target entry');
    if (stat.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed: ${candidate}`);
    }
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(candidate).sort()) {
            inspectExistingTree(path.join(candidate, entry), root);
        }
        return;
    }
    if (!stat.isFile()) {
        throw new Error(`non-regular files are not allowed: ${candidate}`);
    }
}

function copyRegularTree(
    sourceDirectory: string,
    destinationRoot: string,
    copiedFiles: string[],
    relativePrefix = '',
): void {
    const stat = fs.lstatSync(sourceDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
            `source entry must be a real directory: ${sourceDirectory}`,
        );
    }

    for (const entry of fs.readdirSync(sourceDirectory).sort()) {
        const sourcePath = path.join(sourceDirectory, entry);
        const relativePath = path.join(relativePrefix, entry);
        const destinationPath = path.resolve(destinationRoot, relativePath);
        assertPathInside(destinationRoot, destinationPath, 'Distribution entry');
        const entryStat = fs.lstatSync(sourcePath);

        if (entryStat.isSymbolicLink()) {
            throw new Error(`symbolic links are not allowed: ${sourcePath}`);
        }
        if (entryStat.isDirectory()) {
            if (fs.existsSync(destinationPath)) {
                const destinationStat = fs.lstatSync(destinationPath);
                if (
                    destinationStat.isSymbolicLink()
                    || !destinationStat.isDirectory()
                ) {
                    throw new Error(
                        `source path collides with an existing file: ${relativePath}`,
                    );
                }
            } else {
                fs.mkdirSync(destinationPath);
            }
            copyRegularTree(
                sourcePath,
                destinationRoot,
                copiedFiles,
                relativePath,
            );
            continue;
        }
        if (!entryStat.isFile()) {
            throw new Error(`non-regular files are not allowed: ${sourcePath}`);
        }
        if (fs.existsSync(destinationPath)) {
            throw new Error(
                `source files collide at distribution path: ${relativePath}`,
            );
        }
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        copiedFiles.push(relativePath.split(path.sep).join('/'));
    }
}

function rebuildPrePublish(
    sourceRootInput: string,
    repositoryRootInput: string,
    target: DistributionTarget,
): string[] {
    const sourceRoot = requireDirectory(sourceRootInput, 'Source root');
    const repositoryRoot = requireDirectory(
        repositoryRootInput,
        'Repository root',
    );
    assertDisjointRoots(sourceRoot, repositoryRoot);

    const shareRoot = path.resolve(sourceRoot, 'share');
    assertPathInside(sourceRoot, shareRoot, 'Shared source directory');
    requireDirectory(shareRoot, 'Shared source directory');

    const platformRoot = path.resolve(sourceRoot, target);
    assertPathInside(sourceRoot, platformRoot, 'Platform source directory');
    if (fs.existsSync(platformRoot)) {
        requireDirectory(platformRoot, 'Platform source directory');
    }

    const manifestPath = path.resolve(sourceRoot, 'manifest.json');
    assertPathInside(sourceRoot, manifestPath, 'Manifest');
    let manifestStat: import('node:fs').Stats;
    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch (error) {
        throw new Error(`manifest.json is required: ${(error as Error).message}`);
    }
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        throw new Error('manifest.json must be a regular file');
    }

    const prePublishRoot = path.resolve(repositoryRoot, 'pre-publish');
    assertPathInside(repositoryRoot, prePublishRoot, 'pre-publish directory');
    if (fs.existsSync(prePublishRoot)) {
        inspectExistingTree(prePublishRoot, prePublishRoot);
        fs.rmSync(prePublishRoot, { recursive: true, force: false });
    }
    fs.mkdirSync(prePublishRoot);

    const copiedFiles: string[] = [];
    copyRegularTree(shareRoot, prePublishRoot, copiedFiles);
    if (fs.existsSync(platformRoot)) {
        copyRegularTree(platformRoot, prePublishRoot, copiedFiles);
    }

    const destinationManifest = path.resolve(
        prePublishRoot,
        'manifest.json',
    );
    assertPathInside(prePublishRoot, destinationManifest, 'Target manifest');
    if (fs.existsSync(destinationManifest)) {
        throw new Error(
            'source files collide with the required distribution manifest',
        );
    }
    fs.copyFileSync(manifestPath, destinationManifest);
    copiedFiles.push('manifest.json');
    return copiedFiles.sort();
}

function normalizeRemoteRepository(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(
        trimmed,
    );
    if (scpMatch) {
        return scpMatch[1].replace(/\.git$/i, '').toLowerCase();
    }
    try {
        const url = new URL(trimmed);
        if (url.hostname.toLowerCase() !== 'github.com') {
            return null;
        }
        return url.pathname
            .replace(/^\/+|\/+$/g, '')
            .replace(/\.git$/i, '')
            .toLowerCase();
    } catch {
        return null;
    }
}

function assertRepositoryIdentity(
    runner: CommandRunner,
    repositoryRoot: string,
    config: TargetConfig,
): void {
    const topLevel = path.resolve(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', '--show-toplevel'],
            'Resolving the target repository root',
        ).trim(),
    );
    const expectedRoot = fs.realpathSync(repositoryRoot);
    if (topLevel.toLowerCase() !== expectedRoot.toLowerCase()) {
        throw new Error(
            `repository root mismatch: expected ${expectedRoot}, got ${topLevel}`,
        );
    }
    const remoteUrl = runGit(
        runner,
        repositoryRoot,
        ['remote', 'get-url', 'origin'],
        'Reading the target origin URL',
    );
    const normalized = normalizeRemoteRepository(remoteUrl);
    if (normalized !== config.repository.toLowerCase()) {
        throw new Error(
            `origin does not match ${config.repository}: ${remoteUrl.trim()}`,
        );
    }
}

function assertCleanWorktree(
    runner: CommandRunner,
    repositoryRoot: string,
): void {
    const status = runGit(
        runner,
        repositoryRoot,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        'Checking the target worktree',
    );
    if (status.length !== 0) {
        throw new Error('target worktree must be clean before distribution');
    }
}

function parseFullSha(value: string, label: string): string {
    const normalized = value.trim().toLowerCase();
    if (!FULL_SHA_PATTERN.test(normalized)) {
        throw new Error(`${label} did not return one full commit SHA`);
    }
    return normalized;
}

function prepareTarget(
    options: PrepareOptions,
    dependencies: RuntimeDependencies = {},
): PrepareResult {
    const runner = dependencies.runner || defaultCommandRunner;
    const config = getTargetConfig(options.target);
    const repositoryRoot = requireDirectory(
        options.repositoryRoot,
        'Repository root',
    );
    assertRepositoryIdentity(runner, repositoryRoot, config);
    assertCleanWorktree(runner, repositoryRoot);

    const baseSha = parseFullSha(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', 'HEAD'],
            'Resolving the checked-out target main branch',
        ),
        'Target main',
    );
    runGit(
        runner,
        repositoryRoot,
        ['checkout', '-B', AUTOMATION_BRANCH, baseSha],
        'Switching to the automation branch',
    );

    const copiedFiles = rebuildPrePublish(
        options.sourceRoot,
        repositoryRoot,
        options.target,
    );
    return {
        baseSha,
        branch: AUTOMATION_BRANCH,
        copiedFiles,
    };
}

function requireEnvironment(
    env: NodeJS.ProcessEnv,
    name: string,
): string {
    const value = env[name];
    if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
        throw new Error(`${name} must be a non-empty single-line value`);
    }
    return value;
}

function loadSourceSha(env: NodeJS.ProcessEnv = process.env): string {
    return parseFullSha(
        requireEnvironment(env, 'GITHUB_SHA'),
        'GITHUB_SHA',
    );
}

function loadPublishMetadata(
    env: NodeJS.ProcessEnv = process.env,
): PublishMetadata {
    const token = requireEnvironment(env, 'GH_TOKEN');
    const sourceSha = loadSourceSha(env);
    const sourceTimestamp = requireEnvironment(
        env,
        'DISTRIBUTION_SOURCE_TIMESTAMP',
    );
    if (
        !STRICT_ISO_TIMESTAMP.test(sourceTimestamp)
        || Number.isNaN(Date.parse(sourceTimestamp))
    ) {
        throw new Error(
            'DISTRIBUTION_SOURCE_TIMESTAMP must be a strict ISO 8601 timestamp',
        );
    }
    const sourceRepository = requireEnvironment(env, 'GITHUB_REPOSITORY');
    if (sourceRepository.toLowerCase() !== SOURCE_REPOSITORY.toLowerCase()) {
        throw new Error(
            `GITHUB_REPOSITORY must be ${SOURCE_REPOSITORY}`,
        );
    }
    const serverUrl = requireEnvironment(env, 'GITHUB_SERVER_URL').replace(
        /\/+$/,
        '',
    );
    if (serverUrl.toLowerCase() !== 'https://github.com') {
        throw new Error('GITHUB_SERVER_URL must be https://github.com');
    }
    const runId = requireEnvironment(env, 'GITHUB_RUN_ID');
    const runAttempt = requireEnvironment(env, 'GITHUB_RUN_ATTEMPT');
    if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
        throw new Error('GitHub run identifiers must be positive integers');
    }
    return {
        token,
        sourceSha,
        sourceTimestamp,
        sourceRepository,
        serverUrl,
        runId,
        runAttempt,
    };
}

function validateRepositoryPolicyPayload(
    payload: unknown,
    config: TargetConfig,
): void {
    if (!isUnknownRecord(payload)) {
        throw new Error('repository policy response must be an object');
    }
    const fullName = payload.full_name;
    if (
        typeof fullName !== 'string'
        || fullName.toLowerCase() !== config.repository.toLowerCase()
    ) {
        throw new Error('repository policy response identified the wrong repository');
    }
    if (payload.default_branch !== 'main') {
        throw new Error('target default branch must be main');
    }
    for (const field of [
        'allow_auto_merge',
        'allow_rebase_merge',
        'delete_branch_on_merge',
    ]) {
        if (payload[field] !== true) {
            throw new Error(`${field} must be enabled on ${config.repository}`);
        }
    }
}

function rulesetRequiredCheckIsValid(
    payload: unknown,
    config: TargetConfig,
): boolean {
    if (!Array.isArray(payload)) {
        throw new Error('effective rules response must be an array');
    }
    return payload.some((rule) => {
        if (
            !isUnknownRecord(rule)
            || rule.type !== 'required_status_checks'
            || !isUnknownRecord(rule.parameters)
            || rule.parameters.strict_required_status_checks_policy !== true
            || !Array.isArray(rule.parameters.required_status_checks)
        ) {
            return false;
        }
        return rule.parameters.required_status_checks.some(
            (check) =>
                isUnknownRecord(check)
                && check.context === config.requiredCheck
                && check.integration_id === EXPECTED_INTEGRATION_ID,
        );
    });
}

function verifyMergePolicy(
    runner: CommandRunner,
    repositoryRoot: string,
    metadata: PublishMetadata,
    config: TargetConfig,
): void {
    const repositoryPayload = parseJson(
        runGh(
            runner,
            repositoryRoot,
            metadata.token,
            ['api', `repos/${config.repository}`],
            'Reading target repository settings',
        ),
        'Reading target repository settings',
    );
    validateRepositoryPolicyPayload(repositoryPayload, config);

    const effectiveRules = parseJson(
        runGh(
            runner,
            repositoryRoot,
            metadata.token,
            ['api', `repos/${config.repository}/rules/branches/main`],
            'Reading effective branch rules',
        ),
        'Reading effective branch rules',
    );
    const rulesetValid = rulesetRequiredCheckIsValid(effectiveRules, config);
    if (!rulesetValid) {
        throw new Error(
            `${config.repository} must strictly require ${config.requiredCheck} `
            + `from GitHub Actions integration ${EXPECTED_INTEGRATION_ID}`,
        );
    }
}

function parseNulPaths(output: string): string[] {
    return output.split('\0').filter(Boolean);
}

function assertAllowedRepositoryPath(
    value: string,
    config: TargetConfig,
): void {
    const normalized = value.replace(/\\/g, '/');
    const allowed = config.allowedPaths.some(
        (allowedPath) =>
            normalized === allowedPath
            || normalized.startsWith(`${allowedPath}/`),
    );
    if (!allowed) {
        throw new Error(
            `${config.target} distribution changed a path outside its allowlist: `
            + value,
        );
    }
    if (
        normalized.split('/').some((part) => part === '..')
        || path.posix.isAbsolute(normalized)
    ) {
        throw new Error(`invalid repository path returned by Git: ${value}`);
    }
}

function assertOnlyAllowedChanges(
    runner: CommandRunner,
    repositoryRoot: string,
    config: TargetConfig,
): void {
    const queries: readonly (readonly string[])[] = [
        ['diff', '--name-only', '-z', '--'],
        ['diff', '--cached', '--name-only', '-z', '--'],
        ['ls-files', '--others', '--exclude-standard', '-z', '--'],
    ];
    for (const args of queries) {
        const output = runGit(
            runner,
            repositoryRoot,
            args,
            'Inspecting distribution paths',
        );
        for (const changedPath of parseNulPaths(output)) {
            assertAllowedRepositoryPath(changedPath, config);
        }
    }
}

function assertCurrentAutomationBranch(
    runner: CommandRunner,
    repositoryRoot: string,
    operation: string,
): void {
    const branch = runGit(
        runner,
        repositoryRoot,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        'Reading the current target branch',
    ).trim();
    if (branch !== AUTOMATION_BRANCH) {
        throw new Error(
            `${operation} must run from ${AUTOMATION_BRANCH}, not ${branch}`,
        );
    }
}

function stageAllowedPaths(
    runner: CommandRunner,
    repositoryRoot: string,
    config: TargetConfig,
): void {
    runGit(
        runner,
        repositoryRoot,
        ['add', '--all', '--', ...config.allowedPaths],
        'Staging the prepared distribution',
    );
    assertOnlyAllowedChanges(runner, repositoryRoot, config);
}

function assertStagedDiffIsClean(
    runner: CommandRunner,
    repositoryRoot: string,
    config: TargetConfig,
): void {
    runGit(
        runner,
        repositoryRoot,
        ['diff', '--cached', '--check', '--', ...config.allowedPaths],
        'Checking the staged distribution patch',
    );
}

function assertAllowedIndexEntriesAreRegular(
    runner: CommandRunner,
    repositoryRoot: string,
    config: TargetConfig,
): void {
    const output = runGit(
        runner,
        repositoryRoot,
        ['ls-files', '--stage', '-z', '--', ...config.allowedPaths],
        'Inspecting staged distribution entry modes',
    );
    for (const record of parseNulPaths(output)) {
        const separator = record.indexOf('\t');
        const header = separator < 0 ? '' : record.slice(0, separator);
        const repositoryPath =
            separator < 0 ? '' : record.slice(separator + 1);
        const fields = header.split(' ');
        if (
            fields.length !== 3
            || !/^[0-7]{6}$/.test(fields[0])
            || !/^[0-9a-f]{40,64}$/.test(fields[1])
            || !/^[0-3]$/.test(fields[2])
            || repositoryPath.length === 0
        ) {
            throw new Error('Git returned a malformed staged distribution entry');
        }
        const [mode, , stage] = fields;
        assertAllowedRepositoryPath(repositoryPath, config);
        if (stage !== '0') {
            throw new Error(
                `staged distribution entry must be at stage 0: ${repositoryPath}`,
            );
        }
        if (mode !== '100644' && mode !== '100755') {
            throw new Error(
                `staged distribution entry must be a regular file: `
                + `${repositoryPath} (${mode})`,
            );
        }
    }
}

function assertAllowedTreesAreRegular(
    repositoryRoot: string,
    config: TargetConfig,
): void {
    for (const allowedPath of config.allowedPaths) {
        const candidate = path.resolve(repositoryRoot, allowedPath);
        assertPathInside(
            repositoryRoot,
            candidate,
            'Allowed distribution path',
        );
        if (fs.existsSync(candidate)) {
            inspectExistingTree(candidate, repositoryRoot);
        }
    }
}

function writeNewRegularFile(
    outputInput: string,
    content: string,
    label: string,
): string {
    const output = path.resolve(outputInput);
    const parent = requireDirectory(path.dirname(output), `${label} directory`);
    const destination = path.join(parent, path.basename(output));
    if (fs.existsSync(destination)) {
        throw new Error(`${label} already exists: ${destination}`);
    }
    fs.writeFileSync(destination, content, {
        encoding: 'utf8',
        flag: 'wx',
    });
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} must be a regular file`);
    }
    return destination;
}

function readBoundedRegularFile(
    input: string,
    maximumBytes: number,
    label: string,
): string {
    const candidate = path.resolve(input);
    let stat: import('node:fs').Stats;
    try {
        stat = fs.lstatSync(candidate);
    } catch (error) {
        throw new Error(`${label} cannot be inspected: ${(error as Error).message}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} must be a regular file`);
    }
    if (stat.size <= 0 || stat.size > maximumBytes) {
        throw new Error(
            `${label} must be between 1 and ${maximumBytes} bytes`,
        );
    }

    const descriptor = fs.openSync(candidate, 'r');
    try {
        const openedStat = fs.fstatSync(descriptor);
        if (
            !openedStat.isFile()
            || openedStat.size !== stat.size
            || openedStat.dev !== stat.dev
            || openedStat.ino !== stat.ino
        ) {
            throw new Error(`${label} changed while it was opened`);
        }
        const buffer = Buffer.alloc(openedStat.size);
        let offset = 0;
        while (offset < buffer.length) {
            const bytesRead = fs.readSync(
                descriptor,
                buffer,
                offset,
                buffer.length - offset,
                offset,
            );
            if (bytesRead === 0) {
                throw new Error(`${label} changed while it was read`);
            }
            offset += bytesRead;
        }
        const extra = Buffer.alloc(1);
        if (fs.readSync(descriptor, extra, 0, 1, offset) !== 0) {
            throw new Error(`${label} changed while it was read`);
        }
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(descriptor);
    }
}

function parseDistributionEnvelope(
    input: string,
    expectedTarget: DistributionTarget,
    expectedSourceSha: string,
): DistributionEnvelope {
    const value = parseJson(input, 'Reading the distribution envelope');
    if (!isUnknownRecord(value)) {
        throw new Error('distribution envelope must be an object');
    }
    const expectedKeys = [
        'baseSha',
        'patch',
        'repository',
        'schema',
        'sourceSha',
        'target',
    ];
    const actualKeys = Object.keys(value).sort();
    if (
        actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
        throw new Error('distribution envelope contains unexpected fields');
    }
    if (value.schema !== ENVELOPE_SCHEMA) {
        throw new Error(`distribution envelope schema must be ${ENVELOPE_SCHEMA}`);
    }
    if (value.target !== expectedTarget) {
        throw new Error('distribution envelope target does not match the CLI target');
    }
    const config = getTargetConfig(expectedTarget);
    if (value.repository !== config.repository) {
        throw new Error(
            'distribution envelope repository does not match the target repository',
        );
    }
    if (typeof value.sourceSha !== 'string') {
        throw new Error('distribution envelope sourceSha must be a string');
    }
    const sourceSha = parseFullSha(value.sourceSha, 'Envelope source SHA');
    if (sourceSha !== expectedSourceSha) {
        throw new Error(
            'distribution envelope source SHA does not match GITHUB_SHA',
        );
    }
    if (typeof value.baseSha !== 'string') {
        throw new Error('distribution envelope baseSha must be a string');
    }
    const baseSha = parseFullSha(value.baseSha, 'Envelope base SHA');
    if (typeof value.patch !== 'string') {
        throw new Error('distribution envelope patch must be a string');
    }
    if (Buffer.byteLength(value.patch, 'utf8') > MAX_PATCH_BYTES) {
        throw new Error(
            `distribution patch exceeds ${MAX_PATCH_BYTES} bytes`,
        );
    }
    return {
        schema: ENVELOPE_SCHEMA,
        target: expectedTarget,
        repository: config.repository,
        baseSha,
        sourceSha,
        patch: value.patch,
    };
}

function exportTarget(
    options: ExportOptions,
    dependencies: RuntimeDependencies = {},
): ExportResult {
    const runner = dependencies.runner || defaultCommandRunner;
    const sourceSha = loadSourceSha(dependencies.env || process.env);
    const config = getTargetConfig(options.target);
    const repositoryRoot = requireDirectory(
        options.repositoryRoot,
        'Repository root',
    );
    assertRepositoryIdentity(runner, repositoryRoot, config);
    assertCurrentAutomationBranch(runner, repositoryRoot, 'export');
    assertOnlyAllowedChanges(runner, repositoryRoot, config);
    stageAllowedPaths(runner, repositoryRoot, config);
    assertStagedDiffIsClean(runner, repositoryRoot, config);
    assertAllowedIndexEntriesAreRegular(runner, repositoryRoot, config);
    assertAllowedTreesAreRegular(repositoryRoot, config);

    const baseSha = parseFullSha(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', 'HEAD'],
            'Resolving the prepared target base',
        ),
        'Prepared target base',
    );
    const patch = runGit(
        runner,
        repositoryRoot,
        [
            'diff',
            '--cached',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--',
            ...config.allowedPaths,
        ],
        'Exporting the prepared distribution patch',
    );
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
        throw new Error(
            `distribution patch exceeds ${MAX_PATCH_BYTES} bytes`,
        );
    }
    const envelope: DistributionEnvelope = {
        schema: ENVELOPE_SCHEMA,
        target: config.target,
        repository: config.repository,
        baseSha,
        sourceSha,
        patch,
    };
    const serialized = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_ENVELOPE_BYTES) {
        throw new Error(
            `distribution envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`,
        );
    }
    const output = writeNewRegularFile(
        options.output,
        serialized,
        'Distribution envelope',
    );
    return {
        baseSha,
        bytes,
        output,
    };
}

function applyTarget(
    options: ApplyOptions,
    dependencies: RuntimeDependencies = {},
): ApplyResult {
    const runner = dependencies.runner || defaultCommandRunner;
    const sourceSha = loadSourceSha(dependencies.env || process.env);
    const config = getTargetConfig(options.target);
    const envelope = parseDistributionEnvelope(
        readBoundedRegularFile(
            options.patchFile,
            MAX_ENVELOPE_BYTES,
            'Distribution envelope',
        ),
        config.target,
        sourceSha,
    );
    const repositoryRoot = requireDirectory(
        options.repositoryRoot,
        'Repository root',
    );
    assertRepositoryIdentity(runner, repositoryRoot, config);
    assertCleanWorktree(runner, repositoryRoot);

    runGit(
        runner,
        repositoryRoot,
        [
            'fetch',
            '--no-tags',
            'origin',
            '+refs/heads/main:refs/remotes/origin/main',
        ],
        'Fetching the target main branch',
    );
    const fetchedMain = parseFullSha(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', 'refs/remotes/origin/main'],
            'Resolving the fetched target main branch',
        ),
        'Fetched target main',
    );
    if (fetchedMain !== envelope.baseSha) {
        throw new Error(
            'target main does not match the distribution envelope base SHA',
        );
    }
    runGit(
        runner,
        repositoryRoot,
        ['checkout', '-B', AUTOMATION_BRANCH, envelope.baseSha],
        'Switching to the verified automation branch',
    );

    if (envelope.patch.length !== 0) {
        writeTemporaryFile('distribution.patch', envelope.patch, (patchPath) => {
            runGit(
                runner,
                repositoryRoot,
                [
                    'apply',
                    '--index',
                    '--binary',
                    '--whitespace=error-all',
                    patchPath,
                ],
                'Applying the prepared distribution patch',
            );
        });
    }
    assertOnlyAllowedChanges(runner, repositoryRoot, config);
    assertStagedDiffIsClean(runner, repositoryRoot, config);
    assertAllowedIndexEntriesAreRegular(runner, repositoryRoot, config);
    assertAllowedTreesAreRegular(repositoryRoot, config);
    return {
        baseSha: envelope.baseSha,
        branch: AUTOMATION_BRANCH,
        changed: stagedDiffExists(runner, repositoryRoot, config),
    };
}

function getRemoteBranchSha(
    runner: CommandRunner,
    repositoryRoot: string,
    token: string,
    branch: string,
): string | null {
    const output = runNetworkGit(
        runner,
        repositoryRoot,
        token,
        ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
        `Reading origin/${branch}`,
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
        return null;
    }
    if (lines.length !== 1) {
        throw new Error(`origin/${branch} returned multiple references`);
    }
    const fields = lines[0].split(/\s+/);
    if (fields[1] !== `refs/heads/${branch}`) {
        throw new Error(`origin/${branch} returned an unexpected reference`);
    }
    return parseFullSha(fields[0], `origin/${branch}`);
}

function getRemoteMainSha(
    runner: CommandRunner,
    repositoryRoot: string,
    token: string,
): string {
    const output = runNetworkGit(
        runner,
        repositoryRoot,
        token,
        ['ls-remote', '--heads', 'origin', 'refs/heads/main'],
        'Reading origin/main',
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) {
        throw new Error('origin/main must resolve to exactly one reference');
    }
    const fields = lines[0].split(/\s+/);
    if (fields[1] !== 'refs/heads/main') {
        throw new Error('origin/main returned an unexpected reference');
    }
    return parseFullSha(fields[0], 'origin/main');
}

function assertRemoteMainUnchanged(
    runner: CommandRunner,
    repositoryRoot: string,
    token: string,
    baseSha: string,
    context: string,
): void {
    if (getRemoteMainSha(runner, repositoryRoot, token) !== baseSha) {
        throw new Error(`origin/main changed ${context}; rerun from prepare`);
    }
}

function assertAutomationTrailer(message: string): void {
    const lines = message.split(/\r?\n/);
    if (!lines.includes(SOURCE_TRAILER)) {
        throw new Error(
            `existing ${AUTOMATION_BRANCH} is not owned by Blog-Project automation`,
        );
    }
    const sourceLines = lines.filter((line) =>
        line.startsWith('Distribution-Source: '),
    );
    if (
        sourceLines.length !== 1
        || !new RegExp(
            `^Distribution-Source: ${SOURCE_REPOSITORY.replace('/', '\\/')}@`
            + '[0-9a-f]{40}$',
        ).test(sourceLines[0])
    ) {
        throw new Error(
            `existing ${AUTOMATION_BRANCH} has an invalid source trailer`,
        );
    }
}

function inspectRemoteAutomationBranch(
    runner: CommandRunner,
    repositoryRoot: string,
    token: string,
): string | null {
    const remoteSha = getRemoteBranchSha(
        runner,
        repositoryRoot,
        token,
        AUTOMATION_BRANCH,
    );
    if (!remoteSha) {
        return null;
    }
    runNetworkGit(
        runner,
        repositoryRoot,
        token,
        [
            'fetch',
            '--no-tags',
            'origin',
            `+refs/heads/${AUTOMATION_BRANCH}:refs/remotes/origin/${AUTOMATION_BRANCH}`,
        ],
        `Fetching origin/${AUTOMATION_BRANCH}`,
    );
    const fetchedSha = parseFullSha(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', `refs/remotes/origin/${AUTOMATION_BRANCH}`],
            `Resolving origin/${AUTOMATION_BRANCH}`,
        ),
        `origin/${AUTOMATION_BRANCH}`,
    );
    if (fetchedSha !== remoteSha) {
        throw new Error(
            `origin/${AUTOMATION_BRANCH} changed while it was inspected`,
        );
    }
    const message = runGit(
        runner,
        repositoryRoot,
        ['show', '-s', '--format=%B', fetchedSha],
        `Reading origin/${AUTOMATION_BRANCH} metadata`,
    );
    assertAutomationTrailer(message);
    return remoteSha;
}

function parsePullRequest(value: unknown): PullRequestInfo {
    if (
        !isUnknownRecord(value)
        || typeof value.number !== 'number'
        || !Number.isSafeInteger(value.number)
        || value.number <= 0
        || typeof value.url !== 'string'
        || typeof value.baseRefName !== 'string'
        || typeof value.headRefName !== 'string'
        || typeof value.headRefOid !== 'string'
        || typeof value.isDraft !== 'boolean'
        || !isUnknownRecord(value.headRepositoryOwner)
        || typeof value.headRepositoryOwner.login !== 'string'
    ) {
        throw new Error('GitHub returned malformed pull request data');
    }
    let autoMergeRequest: PullRequestInfo['autoMergeRequest'] = null;
    if (value.autoMergeRequest !== null && value.autoMergeRequest !== undefined) {
        if (
            !isUnknownRecord(value.autoMergeRequest)
            || value.autoMergeRequest.mergeMethod !== 'REBASE'
        ) {
            throw new Error(
                'existing pull request auto-merge must use the REBASE method',
            );
        }
        autoMergeRequest = { mergeMethod: 'REBASE' };
    }
    return {
        autoMergeRequest,
        baseRefName: value.baseRefName,
        headRefName: value.headRefName,
        headRefOid: parseFullSha(value.headRefOid, 'Pull request head'),
        headRepositoryOwner: {
            login: value.headRepositoryOwner.login,
        },
        isDraft: value.isDraft,
        number: value.number,
        url: value.url,
    };
}

function findOpenDistributionPr(
    runner: CommandRunner,
    repositoryRoot: string,
    metadata: PublishMetadata,
    config: TargetConfig,
): PullRequestInfo | null {
    const output = runGh(
        runner,
        repositoryRoot,
        metadata.token,
        [
            'pr',
            'list',
            '--repo',
            config.repository,
            '--head',
            AUTOMATION_BRANCH,
            '--base',
            'main',
            '--state',
            'open',
            '--limit',
            '2',
            '--json',
            [
                'autoMergeRequest',
                'baseRefName',
                'headRefName',
                'headRefOid',
                'headRepositoryOwner',
                'isDraft',
                'number',
                'url',
            ].join(','),
        ],
        'Finding the distribution pull request',
    );
    const payload = parseJson(output, 'Finding the distribution pull request');
    if (!Array.isArray(payload)) {
        throw new Error('GitHub pull request list must be an array');
    }
    if (payload.length > 1) {
        throw new Error(
            `multiple open pull requests use ${AUTOMATION_BRANCH}`,
        );
    }
    if (payload.length === 0) {
        return null;
    }
    const pullRequest = parsePullRequest(payload[0]);
    if (
        pullRequest.baseRefName !== 'main'
        || pullRequest.headRefName !== AUTOMATION_BRANCH
        || pullRequest.headRepositoryOwner.login.toLowerCase() !== 'solitudera'
    ) {
        throw new Error('the open distribution pull request has unexpected refs');
    }
    return pullRequest;
}

function buildCommitMessage(metadata: PublishMetadata): string {
    return [
        'chore: sync articles from Blog-Project',
        '',
        SOURCE_TRAILER,
        `Distribution-Source: ${SOURCE_REPOSITORY}@${metadata.sourceSha}`,
    ].join('\n');
}

function buildPullRequestBody(
    metadata: PublishMetadata,
    config: TargetConfig,
): string {
    return [
        '<!-- blog-project-distribution -->',
        '',
        `Synchronizes the validated ${config.target} article snapshot from Blog-Project.`,
        '',
        `Source: ${metadata.serverUrl}/${metadata.sourceRepository}/commit/${metadata.sourceSha}`,
        `Workflow: ${metadata.serverUrl}/${metadata.sourceRepository}/actions/runs/${metadata.runId}/attempts/${metadata.runAttempt}`,
        '',
        `Managed branch: \`${AUTOMATION_BRANCH}\`. Do not push to it manually.`,
        '',
    ].join('\n');
}

function writeTemporaryFile(
    name: string,
    content: string,
    callback: (filePath: string) => void,
): void {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-distribution-'),
    );
    try {
        const filePath = path.join(temporaryRoot, name);
        fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
        callback(filePath);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function createDistributionPr(
    runner: CommandRunner,
    repositoryRoot: string,
    metadata: PublishMetadata,
    config: TargetConfig,
): void {
    writeTemporaryFile(
        'body.md',
        buildPullRequestBody(metadata, config),
        (bodyPath) => {
            runGh(
                runner,
                repositoryRoot,
                metadata.token,
                [
                    'pr',
                    'create',
                    '--repo',
                    config.repository,
                    '--base',
                    'main',
                    '--head',
                    AUTOMATION_BRANCH,
                    '--title',
                    'chore: sync articles from Blog-Project',
                    '--body-file',
                    bodyPath,
                ],
                'Creating the distribution pull request',
            );
        },
    );
}

function updateDistributionPr(
    runner: CommandRunner,
    repositoryRoot: string,
    metadata: PublishMetadata,
    config: TargetConfig,
    pullRequest: PullRequestInfo,
): void {
    writeTemporaryFile(
        'pull-request.json',
        `${JSON.stringify({
            title: 'chore: sync articles from Blog-Project',
            body: buildPullRequestBody(metadata, config),
        })}\n`,
        (inputPath) => {
            runGh(
                runner,
                repositoryRoot,
                metadata.token,
                [
                    'api',
                    '--method',
                    'PATCH',
                    `repos/${config.repository}/pulls/${pullRequest.number}`,
                    '--input',
                    inputPath,
                ],
                'Updating the distribution pull request',
            );
        },
    );
}

function closeStalePullRequest(
    runner: CommandRunner,
    repositoryRoot: string,
    metadata: PublishMetadata,
    config: TargetConfig,
    pullRequest: PullRequestInfo,
    remoteBranchSha: string | null,
    baseSha: string,
): void {
    if (!remoteBranchSha || pullRequest.headRefOid !== remoteBranchSha) {
        throw new Error(
            'refusing to close a pull request whose remote head was not verified',
        );
    }
    if (pullRequest.autoMergeRequest !== null) {
        runGh(
            runner,
            repositoryRoot,
            metadata.token,
            [
                'pr',
                'merge',
                String(pullRequest.number),
                '--repo',
                config.repository,
                '--disable-auto',
            ],
            'Disabling stale pull request auto-merge',
        );
        assertRemoteMainUnchanged(
            runner,
            repositoryRoot,
            metadata.token,
            baseSha,
            'after stale auto-merge was disabled',
        );
    }
    runGh(
        runner,
        repositoryRoot,
        metadata.token,
        [
            'pr',
            'close',
            String(pullRequest.number),
            '--repo',
            config.repository,
            '--comment',
            `Blog-Project@${metadata.sourceSha} has no remaining distribution diff.`,
        ],
        'Closing the stale distribution pull request',
    );
    assertRemoteMainUnchanged(
        runner,
        repositoryRoot,
        metadata.token,
        baseSha,
        'after the stale distribution pull request was closed',
    );
    const currentBranchSha = getRemoteBranchSha(
        runner,
        repositoryRoot,
        metadata.token,
        AUTOMATION_BRANCH,
    );
    if (currentBranchSha !== remoteBranchSha) {
        throw new Error(
            `origin/${AUTOMATION_BRANCH} changed during stale cleanup; `
            + 'refusing to delete it',
        );
    }
    runNetworkGit(
        runner,
        repositoryRoot,
        metadata.token,
        [
            'push',
            `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:${remoteBranchSha}`,
            'origin',
            `:refs/heads/${AUTOMATION_BRANCH}`,
        ],
        'Deleting the verified stale automation branch',
    );
    if (
        getRemoteBranchSha(
            runner,
            repositoryRoot,
            metadata.token,
            AUTOMATION_BRANCH,
        ) !== null
    ) {
        throw new Error(
            `origin/${AUTOMATION_BRANCH} still exists after verified deletion`,
        );
    }
}

function stagedDiffExists(
    runner: CommandRunner,
    repositoryRoot: string,
    config: TargetConfig,
): boolean {
    const result = runner(
        'git',
        ['diff', '--cached', '--quiet', '--', ...config.allowedPaths],
        { cwd: repositoryRoot },
    );
    if (result.error) {
        throw new Error(
            `Checking the staged distribution failed: ${result.error.message}`,
        );
    }
    if (result.status === 0) {
        return false;
    }
    if (result.status === 1) {
        return true;
    }
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(
        `Checking the staged distribution failed${
            detail ? `: ${detail}` : ''
        }`,
    );
}

function publishTarget(
    options: PublishOptions,
    dependencies: RuntimeDependencies = {},
): PublishResult {
    const runner = dependencies.runner || defaultCommandRunner;
    const env = dependencies.env || process.env;
    const metadata = loadPublishMetadata(env);
    const config = getTargetConfig(options.target);
    const repositoryRoot = requireDirectory(
        options.repositoryRoot,
        'Repository root',
    );
    assertRepositoryIdentity(runner, repositoryRoot, config);
    verifyMergePolicy(runner, repositoryRoot, metadata, config);

    assertCurrentAutomationBranch(runner, repositoryRoot, 'publish');
    assertOnlyAllowedChanges(runner, repositoryRoot, config);
    const baseSha = parseFullSha(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', 'HEAD'],
            'Resolving the prepared target base',
        ),
        'Prepared target base',
    );
    assertRemoteMainUnchanged(
        runner,
        repositoryRoot,
        metadata.token,
        baseSha,
        'after prepare',
    );

    const remoteBranchSha = inspectRemoteAutomationBranch(
        runner,
        repositoryRoot,
        metadata.token,
    );
    stageAllowedPaths(runner, repositoryRoot, config);
    assertStagedDiffIsClean(runner, repositoryRoot, config);
    assertAllowedIndexEntriesAreRegular(runner, repositoryRoot, config);

    const pullRequestBeforePush = findOpenDistributionPr(
        runner,
        repositoryRoot,
        metadata,
        config,
    );
    if (!stagedDiffExists(runner, repositoryRoot, config)) {
        assertRemoteMainUnchanged(
            runner,
            repositoryRoot,
            metadata.token,
            baseSha,
            'before resolving a no-diff distribution',
        );
        if (pullRequestBeforePush) {
            closeStalePullRequest(
                runner,
                repositoryRoot,
                metadata,
                config,
                pullRequestBeforePush,
                remoteBranchSha,
                baseSha,
            );
            assertRemoteMainUnchanged(
                runner,
                repositoryRoot,
                metadata.token,
                baseSha,
                'while the stale distribution pull request was closed',
            );
            return {
                action: 'closed-stale-pr',
                branch: AUTOMATION_BRANCH,
                pullRequestNumber: pullRequestBeforePush.number,
                pullRequestUrl: pullRequestBeforePush.url,
            };
        }
        return {
            action: 'no-op',
            branch: AUTOMATION_BRANCH,
        };
    }

    if (
        pullRequestBeforePush
        && (!remoteBranchSha
            || pullRequestBeforePush.headRefOid !== remoteBranchSha)
    ) {
        throw new Error(
            'open distribution pull request does not match the verified remote branch',
        );
    }
    assertRemoteMainUnchanged(
        runner,
        repositoryRoot,
        metadata.token,
        baseSha,
        'before commit',
    );

    const commitEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_AUTHOR_DATE: metadata.sourceTimestamp,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_DATE: metadata.sourceTimestamp,
    };
    runGit(
        runner,
        repositoryRoot,
        [
            'commit',
            '--no-gpg-sign',
            '-m',
            buildCommitMessage(metadata),
        ],
        'Committing the prepared distribution',
        commitEnvironment,
    );
    const commitSha = parseFullSha(
        runGit(
            runner,
            repositoryRoot,
            ['rev-parse', 'HEAD'],
            'Resolving the distribution commit',
        ),
        'Distribution commit',
    );
    assertRemoteMainUnchanged(
        runner,
        repositoryRoot,
        metadata.token,
        baseSha,
        'before the automation branch push',
    );

    const pushArgs = remoteBranchSha
        ? [
              'push',
              `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:${remoteBranchSha}`,
              'origin',
              `HEAD:refs/heads/${AUTOMATION_BRANCH}`,
          ]
        : [
              'push',
              `--force-with-lease=refs/heads/${AUTOMATION_BRANCH}:`,
              'origin',
              `HEAD:refs/heads/${AUTOMATION_BRANCH}`,
          ];
    runNetworkGit(
        runner,
        repositoryRoot,
        metadata.token,
        pushArgs,
        'Pushing the automation branch',
    );
    const pushedSha = getRemoteBranchSha(
        runner,
        repositoryRoot,
        metadata.token,
        AUTOMATION_BRANCH,
    );
    if (pushedSha !== commitSha) {
        throw new Error('the remote automation branch does not match the commit');
    }

    let pullRequest = findOpenDistributionPr(
        runner,
        repositoryRoot,
        metadata,
        config,
    );
    if (!pullRequest) {
        createDistributionPr(
            runner,
            repositoryRoot,
            metadata,
            config,
        );
        pullRequest = findOpenDistributionPr(
            runner,
            repositoryRoot,
            metadata,
            config,
        );
        if (!pullRequest) {
            throw new Error(
                'GitHub did not return the newly created distribution pull request',
            );
        }
    }
    if (pullRequest.headRefOid !== commitSha) {
        throw new Error(
            'distribution pull request head does not match the pushed commit',
        );
    }
    updateDistributionPr(
        runner,
        repositoryRoot,
        metadata,
        config,
        pullRequest,
    );
    if (pullRequest.isDraft) {
        runGh(
            runner,
            repositoryRoot,
            metadata.token,
            [
                'pr',
                'ready',
                String(pullRequest.number),
                '--repo',
                config.repository,
            ],
            'Marking the distribution pull request ready',
        );
    }
    assertRemoteMainUnchanged(
        runner,
        repositoryRoot,
        metadata.token,
        baseSha,
        'before auto-merge was enabled',
    );
    if (pullRequest.autoMergeRequest === null) {
        runGh(
            runner,
            repositoryRoot,
            metadata.token,
            [
                'pr',
                'merge',
                String(pullRequest.number),
                '--repo',
                config.repository,
                '--auto',
                '--rebase',
                '--match-head-commit',
                commitSha,
            ],
            'Enabling distribution pull request auto-merge',
        );
    }
    return {
        action: 'published',
        branch: AUTOMATION_BRANCH,
        commitSha,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
    };
}

export interface DistributeTargetExports {
    AUTOMATION_BRANCH: typeof AUTOMATION_BRANCH;
    EXPECTED_INTEGRATION_ID: typeof EXPECTED_INTEGRATION_ID;
    MAX_ENVELOPE_BYTES: typeof MAX_ENVELOPE_BYTES;
    TARGETS: typeof TARGETS;
    applyTarget: typeof applyTarget;
    assertAutomationTrailer: typeof assertAutomationTrailer;
    assertOnlyAllowedChanges: typeof assertOnlyAllowedChanges;
    buildCommitMessage: typeof buildCommitMessage;
    defaultCommandRunner: typeof defaultCommandRunner;
    exportTarget: typeof exportTarget;
    findOpenDistributionPr: typeof findOpenDistributionPr;
    loadPublishMetadata: typeof loadPublishMetadata;
    loadSourceSha: typeof loadSourceSha;
    parseCliArgs: typeof parseCliArgs;
    parseDistributionEnvelope: typeof parseDistributionEnvelope;
    prepareTarget: typeof prepareTarget;
    publishTarget: typeof publishTarget;
    rebuildPrePublish: typeof rebuildPrePublish;
    rulesetRequiredCheckIsValid: typeof rulesetRequiredCheckIsValid;
    validateRepositoryPolicyPayload: typeof validateRepositoryPolicyPayload;
    verifyMergePolicy: typeof verifyMergePolicy;
}

module.exports = {
    AUTOMATION_BRANCH,
    EXPECTED_INTEGRATION_ID,
    MAX_ENVELOPE_BYTES,
    TARGETS,
    applyTarget,
    assertAutomationTrailer,
    assertOnlyAllowedChanges,
    buildCommitMessage,
    defaultCommandRunner,
    exportTarget,
    findOpenDistributionPr,
    loadPublishMetadata,
    loadSourceSha,
    parseCliArgs,
    parseDistributionEnvelope,
    prepareTarget,
    publishTarget,
    rebuildPrePublish,
    rulesetRequiredCheckIsValid,
    validateRepositoryPolicyPayload,
    verifyMergePolicy,
};

if (require.main === module) {
    try {
        const options = parseCliArgs(process.argv.slice(2));
        if (options.mode === 'prepare') {
            const result = prepareTarget(options);
            console.log(
                `Prepared ${options.target}: branch=${result.branch}, `
                + `base=${result.baseSha}, files=${result.copiedFiles.length}`,
            );
        } else if (options.mode === 'export') {
            const result = exportTarget(options);
            console.log(
                `Exported ${options.target}: base=${result.baseSha}, `
                + `bytes=${result.bytes}, output=${result.output}`,
            );
        } else if (options.mode === 'apply') {
            const result = applyTarget(options);
            console.log(
                `Applied ${options.target}: branch=${result.branch}, `
                + `base=${result.baseSha}, changed=${result.changed}`,
            );
        } else {
            const result = publishTarget(options);
            console.log(
                `Published ${options.target}: action=${result.action}, `
                + `branch=${result.branch}${
                    result.pullRequestUrl
                        ? `, pull_request=${result.pullRequestUrl}`
                        : ''
                }`,
            );
        }
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
}
