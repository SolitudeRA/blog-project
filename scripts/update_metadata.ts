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

interface MetadataOptions {
    rootDir?: string;
    gitRunner?: GitRunner;
    log?: boolean;
}

interface TimestampOptions {
    rootDir: string;
    filePath: string;
    gitRunner?: GitRunner;
}

interface ParsedArticle {
    content: string;
    parsed: import('gray-matter').GrayMatterFile<string>;
}

interface MetadataPlanArticle {
    filePath: string;
    relativePath: string;
    timestamp: string;
    changed: boolean;
    content: string;
}

interface MetadataPlan {
    rootDir: string;
    directoryPath: string;
    plans: MetadataPlanArticle[];
}

interface MetadataUpdateResult {
    processed: number;
    changed: number;
    unchanged: number;
    writes: string[];
}

const fs: typeof import('fs-extra') = require('fs-extra');
const matter: typeof import('gray-matter') = require('gray-matter');
const path: typeof import('node:path') = require('node:path');
const {
    defaultGitRunner,
}: ManifestHistoryModule = require('./resolve_manifest_history.ts');

const STRICT_ISO_TIMESTAMP =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeRelativePath(value: string): string {
    return value.split(path.sep).join('/');
}

function assertPathInside(
    rootDir: string,
    candidatePath: string,
    label: string,
): string {
    const relativePath = path.relative(rootDir, candidatePath);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(`${label} must be inside the Git repository: ${candidatePath}`);
    }
    return normalizeRelativePath(relativePath);
}

function runGitChecked(
    gitRunner: GitRunner,
    rootDir: string,
    args: readonly string[],
    operation: string,
): string {
    let result: GitExecutionResult;
    try {
        result = gitRunner(rootDir, args);
    } catch (error) {
        throw new Error(
            `${operation} could not start: ${(error as Error).message}`,
        );
    }

    if (!result || typeof result !== 'object') {
        throw new Error(`${operation} returned an invalid result`);
    }
    if (result.error) {
        throw new Error(`${operation} could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || '').trim();
        throw new Error(`${operation} failed${detail ? `: ${detail}` : ''}`);
    }
    if (typeof result.stdout !== 'string') {
        throw new Error(`${operation} returned invalid stdout`);
    }
    return result.stdout;
}

function parseGitTimestamp(output: string, relativePath: string): string {
    const values = output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    if (values.length === 0) {
        throw new Error(`No Git commit history exists for ${relativePath}`);
    }
    if (values.length !== 1 || !STRICT_ISO_TIMESTAMP.test(values[0])) {
        throw new Error(
            `Git returned an invalid commit timestamp for ${relativePath}: ${output.trim()}`,
        );
    }
    if (Number.isNaN(Date.parse(values[0]))) {
        throw new Error(
            `Git returned an unparseable commit timestamp for ${relativePath}: ${values[0]}`,
        );
    }
    return values[0];
}

function getLastCommitTimestamp(options: TimestampOptions): string {
    const {
        rootDir,
        filePath,
        gitRunner = defaultGitRunner,
    } = options;
    const relativePath = assertPathInside(rootDir, filePath, 'Article file');
    const output = runGitChecked(
        gitRunner,
        rootDir,
        [
            'log',
            '-1',
            '--format=%cI',
            '--follow',
            '--',
            relativePath,
        ],
        `Reading the last Git commit timestamp for ${relativePath}`,
    );
    return parseGitTimestamp(output, relativePath);
}

function listMarkdownFiles(directoryPath: string): string[] {
    let directoryStat: import('node:fs').Stats;
    try {
        directoryStat = fs.lstatSync(directoryPath);
    } catch (error) {
        throw new Error(
            `Cannot inspect article directory ${directoryPath}: ${(error as Error).message}`,
        );
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error(`Article directory must be a regular directory: ${directoryPath}`);
    }

    return fs
        .readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith('.md'))
        .map((entry) => {
            if (!entry.isFile() || entry.isSymbolicLink()) {
                throw new Error(
                    `Article entry must be a regular Markdown file: ${entry.name}`,
                );
            }
            return path.join(directoryPath, entry.name);
        })
        .sort((left, right) => left.localeCompare(right));
}

function parseArticle(filePath: string): ParsedArticle {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw new Error(
            `Cannot read article ${filePath}: ${(error as Error).message}`,
        );
    }
    if (!/^---\r?\n/.test(content)) {
        throw new Error(`Article is missing front matter: ${filePath}`);
    }

    try {
        return {
            content,
            parsed: matter(content),
        };
    } catch (error) {
        throw new Error(
            `Cannot parse article ${filePath}: ${(error as Error).message}`,
        );
    }
}

function planMetadataUpdates(
    directory: string,
    options: MetadataOptions = {},
): MetadataPlan {
    const rootDir = path.resolve(options.rootDir || process.cwd());
    const directoryPath = path.resolve(rootDir, directory);
    assertPathInside(rootDir, directoryPath, 'Article directory');

    const gitRunner = options.gitRunner || defaultGitRunner;
    const plans: MetadataPlanArticle[] = [];

    // Resolve every source and Git timestamp before writing anything. A
    // malformed source, missing history, or Git failure is therefore zero-write.
    for (const filePath of listMarkdownFiles(directoryPath)) {
        const { content, parsed } = parseArticle(filePath);
        const timestamp = getLastCommitTimestamp({
            rootDir,
            filePath,
            gitRunner,
        });
        const changed = parsed.data.local_updated_at !== timestamp;
        plans.push({
            filePath,
            relativePath: normalizeRelativePath(path.relative(rootDir, filePath)),
            timestamp,
            changed,
            content: changed
                ? matter.stringify(parsed.content, {
                      ...parsed.data,
                      local_updated_at: timestamp,
                  })
                : content,
        });
    }

    return {
        rootDir,
        directoryPath,
        plans,
    };
}

function applyMetadataUpdates(
    plan: MetadataPlan,
): MetadataUpdateResult {
    const writes: string[] = [];
    for (const article of plan.plans) {
        if (!article.changed) {
            continue;
        }
        fs.writeFileSync(article.filePath, article.content, 'utf8');
        writes.push(article.relativePath);
    }
    return {
        processed: plan.plans.length,
        changed: writes.length,
        unchanged: plan.plans.length - writes.length,
        writes,
    };
}

function updateMetadata(
    directory: string,
    options: MetadataOptions = {},
): MetadataUpdateResult {
    const plan = planMetadataUpdates(directory, options);
    const result = applyMetadataUpdates(plan);

    if (options.log !== false) {
        for (const article of plan.plans) {
            if (article.changed) {
                console.log(
                    `Git commit timestamp applied: ${article.relativePath} (${article.timestamp})`,
                );
            } else {
                console.log(`Metadata already current: ${article.relativePath}`);
            }
        }
    }

    return result;
}

module.exports = {
    STRICT_ISO_TIMESTAMP,
    applyMetadataUpdates,
    getLastCommitTimestamp,
    parseGitTimestamp,
    planMetadataUpdates,
    updateMetadata,
};

if (require.main === module) {
    const targetDir = process.argv[2];
    if (!targetDir || process.argv.length !== 3) {
        console.error(
            'Usage: node scripts/update_metadata.ts <article-directory>',
        );
        process.exitCode = 1;
    } else {
        try {
            const result = updateMetadata(targetDir);
            console.log(
                `Metadata update complete: processed=${result.processed}, `
                + `changed=${result.changed}, unchanged=${result.unchanged}`,
            );
        } catch (error) {
            console.error((error as Error).message);
            process.exitCode = 1;
        }
    }
}
