'use strict';

import type {
    Diagnostic,
    ValidateArticleFilesOptions,
    ValidateArticlesDirectoryOptions,
    ValidationResult,
} from './types.ts';
import type {
    ArticleValidationArticleFilesExports,
} from './article_files.ts';
import type {
    ArticleValidationManifestIoExports,
} from './manifest_io.ts';
import type {
    ArticleValidationValidationExports,
} from './validation.ts';
import type {
    ArticleValidationDiagnosticsExports,
} from './diagnostics.ts';
import type {
    ArticleValidationNormalizationExports,
} from './normalization.ts';

const fs: typeof import('node:fs') = require('node:fs');
const {
    collectMarkdownFiles,
} = require('./article_files.ts') as ArticleValidationArticleFilesExports;
const {
    readManifestFile,
    readPreviousManifestFile,
} = require('./manifest_io.ts') as ArticleValidationManifestIoExports;
const {
    validateArticleFiles,
} = require('./validation.ts') as ArticleValidationValidationExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    normalizePath,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;

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

export interface ArticleValidationDirectoryExports {
    validateArticlesDirectory: typeof validateArticlesDirectory;
}

module.exports = {
    validateArticlesDirectory,
};
