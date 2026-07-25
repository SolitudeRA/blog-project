'use strict';

import type {
    ArticleInput,
    Diagnostic,
    ValidateArticleFilesOptions,
    ValidateArticlesDirectoryOptions,
    ValidationIo,
    ValidationPhase,
    ValidationResult,
} from './article_validation/types.ts';
import type {
    ArticleValidationConstantsExports,
} from './article_validation/constants.ts';
import type {
    ArticleValidationDiagnosticsExports,
} from './article_validation/diagnostics.ts';
import type {
    ArticleValidationSyntaxExports,
} from './article_validation/article_syntax.ts';
import type {
    ArticleValidationArticleExports,
} from './article_validation/article.ts';
import type {
    ArticleValidationManifestExports,
} from './article_validation/manifest.ts';
import type {
    ArticleValidationValidationExports,
} from './article_validation/validation.ts';
import type {
    ArticleValidationNormalizationExports,
} from './article_validation/normalization.ts';

export type {
    ArticleInput,
    ArticleReference,
    Diagnostic,
    ParsedArticle,
    ParseArticleResult,
    Platform,
    SourceKind,
    UnknownRecord,
    ValidateArticleFilesOptions,
    ValidateArticlesDirectoryOptions,
    ValidationCounts,
    ValidationIo,
    ValidationPhase,
    ValidationResult,
} from './article_validation/types.ts';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const {
    ARTICLE_ID_PATTERN,
    SERIES_END,
    SERIES_START,
    SOURCE_KINDS,
} = require(
    './article_validation/constants.ts'
) as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require(
    './article_validation/diagnostics.ts'
) as ArticleValidationDiagnosticsExports;
const {
    decodeUtf8,
    extractArticleReferences,
    isTimestampWithTimezone,
    validateBytes,
    validateSeriesMarkers,
} = require(
    './article_validation/article_syntax.ts'
) as ArticleValidationSyntaxExports;
const {
    normalizePath,
} = require(
    './article_validation/normalization.ts'
) as ArticleValidationNormalizationExports;
const {
    parseArticle,
} = require(
    './article_validation/article.ts'
) as ArticleValidationArticleExports;
const {
    validateManifest,
    validateManifestHistory,
} = require(
    './article_validation/manifest.ts'
) as ArticleValidationManifestExports;
const {
    validateArticleFiles,
} = require(
    './article_validation/validation.ts'
) as ArticleValidationValidationExports;

function collectMarkdownFiles(
    articlesRoot: string,
    diagnostics: Diagnostic[] = [],
): ArticleInput[] {
    const files: ArticleInput[] = [];

    for (const source of SOURCE_KINDS) {
        const directory = path.join(articlesRoot, source);
        let directoryStat;
        try {
            directoryStat = fs.lstatSync(directory);
        } catch (error) {
            if (
                error instanceof Error
                && (error as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
                if (source === 'share') {
                    diagnostics.push(
                        createDiagnostic(
                            'SHARE_DIRECTORY_MISSING',
                            normalizePath(directory),
                            'articles/share ディレクトリは必須です。',
                        ),
                    );
                }
                continue;
            }
            throw error;
        }

        if (directoryStat.isSymbolicLink()) {
            diagnostics.push(
                createDiagnostic(
                    'SYMLINK_NOT_ALLOWED',
                    normalizePath(directory),
                    '記事ソースディレクトリにシンボリックリンクは使用できません。',
                ),
            );
            continue;
        }

        if (!directoryStat.isDirectory()) {
            diagnostics.push(
                createDiagnostic(
                    'SOURCE_DIRECTORY_INVALID',
                    normalizePath(directory),
                    '記事ソースは通常のディレクトリである必要があります。',
                ),
            );
            continue;
        }

        const entries = fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const absolutePath = path.join(directory, entry.name);
            const diagnosticPath = normalizePath(
                path.join(source, entry.name),
            );

            if (entry.isSymbolicLink()) {
                diagnostics.push(
                    createDiagnostic(
                        'SYMLINK_NOT_ALLOWED',
                        diagnosticPath,
                        '記事ソース内にシンボリックリンクは使用できません。',
                    ),
                );
            } else if (entry.isDirectory()) {
                diagnostics.push(
                    createDiagnostic(
                        'SUBDIRECTORY_NOT_ALLOWED',
                        diagnosticPath,
                        '記事はソースディレクトリ直下に配置してください。',
                    ),
                );
            } else if (!entry.isFile()) {
                diagnostics.push(
                    createDiagnostic(
                        'NON_REGULAR_FILE',
                        diagnosticPath,
                        '記事は通常ファイルである必要があります。',
                    ),
                );
            } else if (!entry.name.endsWith('.md')) {
                diagnostics.push(
                    createDiagnostic(
                        'NON_MARKDOWN_FILE',
                        diagnosticPath,
                        '記事ソース内には小文字の .md ファイルだけを配置してください。',
                    ),
                );
            } else {
                files.push({
                    relativePath: diagnosticPath,
                    bytes: fs.readFileSync(absolutePath),
                });
            }
        }
    }

    return files;
}

function readManifestFile(
    articlesRoot: string,
    diagnostics: Diagnostic[],
): unknown | null {
    const manifestPath = path.join(articlesRoot, 'manifest.json');
    const diagnosticPath = 'manifest.json';
    let manifestStat;

    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch (error) {
        if (
            error instanceof Error
            && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
            diagnostics.push(
                createDiagnostic(
                    'MANIFEST_MISSING',
                    diagnosticPath,
                    'articles/manifest.jsonが必要です。',
                ),
            );
            return null;
        }
        throw error;
    }

    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_MANIFEST_FILE',
                diagnosticPath,
                'manifest.jsonは通常ファイルである必要があります。',
            ),
        );
        return null;
    }

    const buffer = fs.readFileSync(manifestPath);
    if (buffer.length === 0) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_MANIFEST',
                diagnosticPath,
                'manifest.jsonが空です。',
            ),
        );
        return null;
    }

    const byteDiagnostics = validateBytes(buffer, diagnosticPath);
    if (byteDiagnostics.length > 0) {
        diagnostics.push(...byteDiagnostics);
        return null;
    }

    let content;
    try {
        content = decodeUtf8(buffer).content;
    } catch {
        diagnostics.push(
            createDiagnostic(
                'INVALID_UTF8',
                diagnosticPath,
                'manifest.jsonを厳密なUTF-8として読み取れません。',
            ),
        );
        return null;
    }

    try {
        return JSON.parse(content);
    } catch (error) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_MANIFEST_JSON',
                diagnosticPath,
                `manifest.jsonを解析できません: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            ),
        );
        return null;
    }
}

function readPreviousManifestFile(
    manifestPath: string,
    diagnostics: Diagnostic[],
): unknown | null {
    const diagnosticPath = normalizePath(manifestPath);
    let manifestStat;

    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch (error) {
        if (
            error instanceof Error
            && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
            diagnostics.push(
                createDiagnostic(
                    'PREVIOUS_MANIFEST_NOT_FOUND',
                    diagnosticPath,
                    '指定されたprevious manifestが見つかりません。',
                ),
            );
            return null;
        }
        throw error;
    }

    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_PREVIOUS_MANIFEST_FILE',
                diagnosticPath,
                'previous manifestは通常ファイルである必要があります。',
            ),
        );
        return null;
    }

    const buffer = fs.readFileSync(manifestPath);
    const byteDiagnostics = validateBytes(buffer, diagnosticPath);
    if (buffer.length === 0 || byteDiagnostics.length > 0) {
        diagnostics.push(...byteDiagnostics);
        if (buffer.length === 0) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_PREVIOUS_MANIFEST',
                    diagnosticPath,
                    'previous manifestが空です。',
                ),
            );
        }
        return null;
    }

    let content;
    try {
        content = decodeUtf8(buffer).content;
    } catch {
        diagnostics.push(
            createDiagnostic(
                'INVALID_UTF8',
                diagnosticPath,
                'previous manifestを厳密なUTF-8として読み取れません。',
            ),
        );
        return null;
    }

    try {
        return JSON.parse(content);
    } catch (error) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_PREVIOUS_MANIFEST_JSON',
                diagnosticPath,
                `previous manifestを解析できません: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            ),
        );
        return null;
    }
}

function validateArticlesDirectory(
    articlesRoot: string,
    options: ValidateArticlesDirectoryOptions = {},
): ValidationResult {
    if (!fs.existsSync(articlesRoot)) {
        return {
            ok: false,
            phase: options.phase || 'source',
            diagnostics: [
                createDiagnostic(
                    'ARTICLES_ROOT_NOT_FOUND',
                    normalizePath(articlesRoot),
                    '記事ルートディレクトリが見つかりません。',
                ),
            ],
            counts: {
                sourceFiles: 0,
                parsedArticles: 0,
                qiitaArticles: 0,
                zennArticles: 0,
            },
        };
    }

    const rootStat = fs.lstatSync(articlesRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return {
            ok: false,
            phase: options.phase || 'source',
            diagnostics: [
                createDiagnostic(
                    rootStat.isSymbolicLink()
                        ? 'SYMLINK_NOT_ALLOWED'
                        : 'ARTICLES_ROOT_NOT_FOUND',
                    normalizePath(articlesRoot),
                    '記事ルートは通常のディレクトリである必要があります。',
                ),
            ],
            counts: {
                sourceFiles: 0,
                parsedArticles: 0,
                qiitaArticles: 0,
                zennArticles: 0,
            },
        };
    }

    const structureDiagnostics: Diagnostic[] = [];
    const files = collectMarkdownFiles(articlesRoot, structureDiagnostics);
    const manifest = readManifestFile(articlesRoot, structureDiagnostics);
    const validationOptions: ValidateArticleFilesOptions = {
        ...options,
        manifest,
        manifestFile: 'manifest.json',
    };
    if (options.previousManifestPath) {
        const previousManifest = readPreviousManifestFile(
            options.previousManifestPath,
            structureDiagnostics,
        );
        if (previousManifest !== null) {
            validationOptions.previousManifest = previousManifest;
            validationOptions.previousManifestFile = normalizePath(
                options.previousManifestPath,
            );
        }
    }
    const result = validateArticleFiles(files, validationOptions);
    result.diagnostics.push(...structureDiagnostics);
    result.diagnostics.sort(
        (a, b) =>
            a.file.localeCompare(b.file) ||
            a.code.localeCompare(b.code) ||
            a.message.localeCompare(b.message),
    );
    result.ok = result.diagnostics.length === 0;
    return result;
}

function formatResult(result: ValidationResult): string {
    if (result.ok) {
        return [
            `Article validation passed (${result.phase}).`,
            `source=${result.counts.sourceFiles}, qiita=${result.counts.qiitaArticles}, zenn=${result.counts.zennArticles}`,
        ].join(' ');
    }

    return [
        `Article validation failed (${result.phase}): ${result.diagnostics.length} error(s).`,
        ...result.diagnostics.map(
            (item) => `- [${item.code}] ${item.file}: ${item.message}`,
        ),
    ].join('\n');
}

export interface ParsedCliArgs {
    articlesRoot: string;
    phase: ValidationPhase;
    previousManifestPath: string | null;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
    let articlesRoot = 'articles';
    let phase = 'source';
    let previousManifestPath = null;
    let rootSeen = false;

    for (const argument of argv) {
        if (argument.startsWith('--phase=')) {
            phase = argument.slice('--phase='.length);
        } else if (argument.startsWith('--previous-manifest=')) {
            previousManifestPath = argument.slice(
                '--previous-manifest='.length,
            );
            if (!previousManifestPath) {
                throw new TypeError(
                    '--previous-manifest requires a path',
                );
            }
        } else if (!rootSeen) {
            articlesRoot = argument;
            rootSeen = true;
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }

    if (!['source', 'distribution'].includes(phase)) {
        throw new TypeError(`Unknown validation phase: ${phase}`);
    }

    return {
        articlesRoot,
        phase: phase as ValidationPhase,
        previousManifestPath,
    };
}

function runCli(
    argv: string[] = process.argv.slice(2),
    io: ValidationIo = console,
): number {
    try {
        const options = parseCliArgs(argv);
        const result = validateArticlesDirectory(
            path.resolve(options.articlesRoot),
            {
                phase: options.phase,
                previousManifestPath: options.previousManifestPath
                    ? path.resolve(options.previousManifestPath)
                    : null,
            },
        );
        const output = formatResult(result);
        if (result.ok) {
            io.log(output);
            return 0;
        }
        io.error(output);
        return 1;
    } catch (error) {
        io.error(
            `Article validation could not run: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return 2;
    }
}

export interface ValidateArticlesExports {
    ARTICLE_ID_PATTERN: RegExp;
    SERIES_END: string;
    SERIES_START: string;
    collectMarkdownFiles: typeof collectMarkdownFiles;
    extractArticleReferences: typeof extractArticleReferences;
    formatResult: typeof formatResult;
    isTimestampWithTimezone: typeof isTimestampWithTimezone;
    parseArticle: typeof parseArticle;
    parseCliArgs: typeof parseCliArgs;
    readManifestFile: typeof readManifestFile;
    readPreviousManifestFile: typeof readPreviousManifestFile;
    runCli: typeof runCli;
    validateArticleFiles: typeof validateArticleFiles;
    validateArticlesDirectory: typeof validateArticlesDirectory;
    validateManifest: typeof validateManifest;
    validateManifestHistory: typeof validateManifestHistory;
    validateSeriesMarkers: typeof validateSeriesMarkers;
}

module.exports = {
    ARTICLE_ID_PATTERN,
    SERIES_END,
    SERIES_START,
    collectMarkdownFiles,
    extractArticleReferences,
    formatResult,
    isTimestampWithTimezone,
    parseArticle,
    parseCliArgs,
    readManifestFile,
    readPreviousManifestFile,
    runCli,
    validateArticleFiles,
    validateArticlesDirectory,
    validateManifest,
    validateManifestHistory,
    validateSeriesMarkers,
};

if (require.main === module) {
    process.exitCode = runCli();
}
