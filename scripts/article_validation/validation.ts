'use strict';

import type {
    ArticleInput,
    Diagnostic,
    ParsedArticle,
    Platform,
    ValidateArticleFilesOptions,
    ValidationResult,
} from './types.ts';
import type {
    ArticleValidationConstantsExports,
} from './constants.ts';
import type {
    ArticleValidationDiagnosticsExports,
} from './diagnostics.ts';
import type {
    ArticleValidationNormalizationExports,
} from './normalization.ts';
import type {
    ArticleValidationArticleExports,
} from './article.ts';
import type {
    ArticleValidationArticleSetExports,
} from './article_set.ts';
import type {
    ArticleValidationManifestExports,
} from './manifest.ts';

const {
    PLATFORMS,
} = require('./constants.ts') as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    normalizePath,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;
const {
    parseArticle,
} = require('./article.ts') as ArticleValidationArticleExports;
const {
    buildEffectiveArticles,
    requireLocalUpdatedAt,
    validateArticleIds,
    validateFilenameCollisions,
    validatePlatformIdentity,
    validatePlatformSeries,
} = require('./article_set.ts') as ArticleValidationArticleSetExports;
const {
    validateManifest,
    validateManifestHistory,
} = require('./manifest.ts') as ArticleValidationManifestExports;

function validateArticleFiles(
    files: Iterable<ArticleInput>,
    options: ValidateArticleFilesOptions = {},
): ValidationResult {
    const phase = options.phase || 'source';
    if (!['source', 'distribution'].includes(phase)) {
        throw new TypeError(`Unknown validation phase: ${phase}`);
    }

    const diagnostics: Diagnostic[] = [];
    const articles: ParsedArticle[] = [];
    const sortedFiles = [...files].sort((a, b) =>
        normalizePath(a.relativePath || '').localeCompare(
            normalizePath(b.relativePath || ''),
        ),
    );

    for (const file of sortedFiles) {
        const result = parseArticle(file);
        diagnostics.push(...result.diagnostics);
        if (result.article) {
            articles.push(result.article);
        }
    }

    if (sortedFiles.length === 0) {
        diagnostics.push(
            createDiagnostic(
                'NO_ARTICLES',
                '(articles)',
                '公開対象のMarkdown記事が1件もありません。',
            ),
        );
    }

    validateFilenameCollisions(articles, diagnostics);
    validateArticleIds(articles, diagnostics);

    if (Object.prototype.hasOwnProperty.call(options, 'manifest')) {
        if (options.manifest !== null) {
            validateManifest(
                options.manifest,
                articles,
                diagnostics,
                options.manifestFile || 'manifest.json',
            );
            if (options.previousManifest !== undefined) {
                validateManifestHistory(
                    options.previousManifest,
                    options.manifest,
                    diagnostics,
                    options.previousManifestFile ||
                        'previous-manifest.json',
                );
            }
        }
    } else if (options.requireManifest) {
        diagnostics.push(
            createDiagnostic(
                'MANIFEST_MISSING',
                options.manifestFile || 'manifest.json',
                'articles/manifest.jsonが必要です。',
            ),
        );
    }

    const effective: Record<Platform, ParsedArticle[]> = {
        qiita: [],
        zenn: [],
    };
    for (const platform of PLATFORMS) {
        effective[platform] = buildEffectiveArticles(
            articles,
            platform,
            diagnostics,
        );
        validatePlatformIdentity(platform, effective[platform], diagnostics);
        validatePlatformSeries(platform, effective[platform], diagnostics);
    }

    const timestampDiagnostics = new Set<string>();
    for (const article of articles.filter((item) => item.source === 'qiita')) {
        requireLocalUpdatedAt(article, diagnostics, timestampDiagnostics);
    }
    if (phase === 'distribution') {
        for (const article of effective.qiita) {
            requireLocalUpdatedAt(article, diagnostics, timestampDiagnostics);
        }
    }

    diagnostics.sort(
        (a, b) =>
            a.file.localeCompare(b.file) ||
            a.code.localeCompare(b.code) ||
            a.message.localeCompare(b.message),
    );

    return {
        ok: diagnostics.length === 0,
        phase,
        diagnostics,
        counts: {
            sourceFiles: sortedFiles.length,
            parsedArticles: articles.length,
            qiitaArticles: effective.qiita.length,
            zennArticles: effective.zenn.length,
        },
    };
}

export interface ArticleValidationValidationExports {
    validateArticleFiles: typeof validateArticleFiles;
}

module.exports = {
    validateArticleFiles,
};
