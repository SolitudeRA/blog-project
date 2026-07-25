'use strict';

import type {
    Diagnostic,
} from './types.ts';
import type {
    ArticleValidationDiagnosticsExports,
} from './diagnostics.ts';
import type {
    ArticleValidationNormalizationExports,
} from './normalization.ts';
import type {
    ArticleValidationSyntaxExports,
} from './article_syntax.ts';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    normalizePath,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;
const {
    decodeUtf8,
    validateBytes,
} = require('./article_syntax.ts') as ArticleValidationSyntaxExports;

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

export interface ArticleValidationManifestIoExports {
    readManifestFile: typeof readManifestFile;
    readPreviousManifestFile: typeof readPreviousManifestFile;
}

module.exports = {
    readManifestFile,
    readPreviousManifestFile,
};
