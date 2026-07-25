'use strict';

import type {
    ArticleInput,
    Diagnostic,
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

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const {
    SOURCE_KINDS,
} = require('./constants.ts') as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    normalizePath,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;

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

export interface ArticleValidationArticleFilesExports {
    collectMarkdownFiles: typeof collectMarkdownFiles;
}

module.exports = {
    collectMarkdownFiles,
};
