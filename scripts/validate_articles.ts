'use strict';

import type {
    ValidationIo,
    ValidationPhase,
    ValidationResult,
} from './article_validation/types.ts';
import type {
    ArticleValidationConstantsExports,
} from './article_validation/constants.ts';
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
    ArticleValidationArticleFilesExports,
} from './article_validation/article_files.ts';
import type {
    ArticleValidationManifestIoExports,
} from './article_validation/manifest_io.ts';
import type {
    ArticleValidationDirectoryExports,
} from './article_validation/directory.ts';

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

const path: typeof import('node:path') = require('node:path');
const {
    ARTICLE_ID_PATTERN,
    SERIES_END,
    SERIES_START,
} = require(
    './article_validation/constants.ts'
) as ArticleValidationConstantsExports;
const {
    extractArticleReferences,
    isTimestampWithTimezone,
    validateSeriesMarkers,
} = require(
    './article_validation/article_syntax.ts'
) as ArticleValidationSyntaxExports;
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
const {
    collectMarkdownFiles,
} = require(
    './article_validation/article_files.ts'
) as ArticleValidationArticleFilesExports;
const {
    readManifestFile,
    readPreviousManifestFile,
} = require(
    './article_validation/manifest_io.ts'
) as ArticleValidationManifestIoExports;
const {
    validateArticlesDirectory,
} = require(
    './article_validation/directory.ts'
) as ArticleValidationDirectoryExports;


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
