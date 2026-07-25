'use strict';

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
import type {
    ArticleValidationCliExports,
} from './article_validation/cli.ts';

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
export type {
    ParsedCliArgs,
} from './article_validation/cli.ts';

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
const {
    formatResult,
    parseCliArgs,
    runCli,
} = require(
    './article_validation/cli.ts'
) as ArticleValidationCliExports;

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
