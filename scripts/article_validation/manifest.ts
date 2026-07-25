'use strict';

import type {
    Diagnostic,
    ParsedArticle,
    Platform,
    SourceKind,
    UnknownRecord,
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

const {
    ARTICLE_ID_PATTERN,
    ARTICLE_STATES,
    PLATFORMS,
    TARGET_DESIRED_STATES,
} = require('./constants.ts') as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    normalizePath,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;

function isPlainObject(value: unknown): value is UnknownRecord {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function expectedTargetsForSource(source: SourceKind): Platform[] {
    if (source === 'share') {
        return ['qiita', 'zenn'];
    }
    if (source === 'qiita' || source === 'zenn') {
        return [source];
    }
    return [];
}

function validateManifest(
    manifest: unknown,
    articles: ParsedArticle[],
    diagnostics: Diagnostic[],
    manifestFile = 'manifest.json',
): void {
    if (!isPlainObject(manifest)) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_MANIFEST',
                manifestFile,
                'manifestのルートはJSON objectである必要があります。',
            ),
        );
        return;
    }

    const rootKeys = Object.keys(manifest).sort();
    if (
        rootKeys.length !== 2 ||
        rootKeys[0] !== 'articles' ||
        rootKeys[1] !== 'schema_version'
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_MANIFEST_SHAPE',
                manifestFile,
                'manifestのルートはschema_versionとarticlesだけを含めてください。',
            ),
        );
    }

    if (manifest.schema_version !== 1) {
        diagnostics.push(
            createDiagnostic(
                'UNSUPPORTED_MANIFEST_SCHEMA',
                manifestFile,
                'manifest.schema_versionは1である必要があります。',
            ),
        );
    }

    if (!Array.isArray(manifest.articles)) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_MANIFEST',
                manifestFile,
                'manifest.articlesは配列である必要があります。',
            ),
        );
        return;
    }

    const sourceArticles = new Map(
        articles.map((article) => [
            normalizePath(`articles/${article.relativePath}`),
            article,
        ]),
    );
    const manifestBySource = new Map<string, UnknownRecord>();
    const manifestById = new Map<string, UnknownRecord>();

    for (const [index, entry] of manifest.articles.entries()) {
        const entryFile = `${manifestFile}#articles[${index}]`;
        if (!isPlainObject(entry)) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_MANIFEST_ENTRY',
                    entryFile,
                    '各manifest articleはJSON objectである必要があります。',
                ),
            );
            continue;
        }

        const entryKeys = Object.keys(entry).sort();
        const expectedEntryKeys = [
            'article_id',
            'article_state',
            'source',
            'targets',
        ];
        if (
            entryKeys.length !== expectedEntryKeys.length ||
            entryKeys.some(
                (key, keyIndex) => key !== expectedEntryKeys[keyIndex],
            )
        ) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_MANIFEST_ENTRY_SHAPE',
                    entryFile,
                    'manifest articleはarticle_id、source、article_state、targetsだけを含めてください。',
                ),
            );
        }

        const articleId = entry.article_id;
        if (
            typeof articleId !== 'string' ||
            !ARTICLE_ID_PATTERN.test(articleId)
        ) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_MANIFEST_ARTICLE_ID',
                    entryFile,
                    'manifest article_idは32桁の小文字16進数にしてください。',
                ),
            );
        } else if (manifestById.has(articleId)) {
            diagnostics.push(
                createDiagnostic(
                    'DUPLICATE_MANIFEST_ARTICLE_ID',
                    entryFile,
                    `manifest article_id「${articleId}」が重複しています。`,
                ),
            );
        } else {
            manifestById.set(articleId, entry);
        }

        if (
            typeof entry.article_state !== 'string'
            || !ARTICLE_STATES.has(entry.article_state)
        ) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_ARTICLE_STATE',
                    entryFile,
                    'article_stateはactive、retiring、retiredのいずれかにしてください。',
                ),
            );
        } else if (entry.article_state !== 'active') {
            diagnostics.push(
                createDiagnostic(
                    'UNSUPPORTED_ARTICLE_STATE',
                    entryFile,
                    `${entry.article_state}の安全な配信処理はまだ実装されていないため公開できません。`,
                ),
            );
        }

        let normalizedSource = null;
        let sourceKind: SourceKind | null = null;
        if (typeof entry.source === 'string') {
            normalizedSource = normalizePath(entry.source);
            const sourceMatch = normalizedSource.match(
                /^articles\/(share|qiita|zenn)\/[^/]+\.md$/u,
            );
            if (
                normalizedSource !== entry.source ||
                !sourceMatch ||
                normalizedSource.split('/').includes('..')
            ) {
                diagnostics.push(
                    createDiagnostic(
                        'INVALID_MANIFEST_SOURCE',
                        entryFile,
                        'sourceはarticles/{share|qiita|zenn}/<file>.md形式の正規化済みリポジトリ相対パスにしてください。',
                    ),
                );
            } else {
                sourceKind = sourceMatch[1] as SourceKind;
                if (manifestBySource.has(normalizedSource)) {
                    diagnostics.push(
                        createDiagnostic(
                            'DUPLICATE_MANIFEST_SOURCE',
                            entryFile,
                            `manifest source「${normalizedSource}」が重複しています。`,
                        ),
                    );
                } else {
                    manifestBySource.set(normalizedSource, entry);
                }
            }
        } else if (
            entry.source !== null ||
            entry.article_state !== 'retired'
        ) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_MANIFEST_SOURCE',
                    entryFile,
                    'active/retiring articleにはsource文字列が必要です。source:nullはretiredだけで使用できます。',
                ),
            );
        }

        if (!isPlainObject(entry.targets)) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_MANIFEST_TARGETS',
                    entryFile,
                    'targetsはqiita/zennをキーとするJSON objectである必要があります。',
                ),
            );
        } else {
            const targetKeys = Object.keys(entry.targets).sort();
            if (
                targetKeys.length === 0 ||
                targetKeys.some(
                    (platform) => !PLATFORMS.includes(platform as Platform),
                )
            ) {
                diagnostics.push(
                    createDiagnostic(
                        'INVALID_MANIFEST_TARGETS',
                        entryFile,
                        'targetsにはqiitaまたはzennを1件以上指定してください。',
                    ),
                );
            }

            for (const platform of targetKeys) {
                const target = entry.targets[platform];
                if (
                    !isPlainObject(target) ||
                    Object.keys(target).length !== 1 ||
                    !Object.prototype.hasOwnProperty.call(target, 'desired') ||
                    typeof target.desired !== 'string'
                    || !TARGET_DESIRED_STATES.has(target.desired)
                ) {
                    diagnostics.push(
                        createDiagnostic(
                            'INVALID_MANIFEST_TARGET',
                            entryFile,
                            `targets.${platform}はdesired: published|withdrawnだけを含めてください。`,
                        ),
                    );
                } else if (target.desired !== 'published') {
                    diagnostics.push(
                        createDiagnostic(
                            'UNSUPPORTED_TARGET_DESIRED',
                            entryFile,
                            `${platform}のwithdrawn処理はまだ実装されていないため公開できません。`,
                        ),
                    );
                }
            }

            if (sourceKind && entry.article_state === 'active') {
                const expectedTargets = expectedTargetsForSource(sourceKind);
                if (
                    targetKeys.length !== expectedTargets.length ||
                    targetKeys.some(
                        (platform, targetIndex) =>
                            platform !== expectedTargets[targetIndex],
                    )
                ) {
                    diagnostics.push(
                        createDiagnostic(
                            'MANIFEST_TARGET_MISMATCH',
                            entryFile,
                            `${sourceKind} articleのtargetsは ${expectedTargets.join(
                                ', ',
                            )} である必要があります。`,
                        ),
                    );
                }
            }
        }

        if (
            entry.article_state === 'active' &&
            normalizedSource &&
            sourceKind
        ) {
            const sourceArticle = sourceArticles.get(normalizedSource);
            if (!sourceArticle) {
                diagnostics.push(
                    createDiagnostic(
                        'ACTIVE_SOURCE_MISSING',
                        entryFile,
                        `active articleのsourceが見つかりません: ${normalizedSource}`,
                    ),
                );
            } else if (sourceArticle.articleId !== articleId) {
                diagnostics.push(
                    createDiagnostic(
                        'ARTICLE_ID_MISMATCH',
                        sourceArticle.relativePath,
                        `front matter article_id「${sourceArticle.articleId ?? '(missing)'}」がmanifest「${articleId}」と一致しません。`,
                    ),
                );
            }
        }
    }

    for (const article of articles) {
        const source = normalizePath(`articles/${article.relativePath}`);
        if (!manifestBySource.has(source)) {
            diagnostics.push(
                createDiagnostic(
                    'UNMANIFESTED_ARTICLE',
                    article.relativePath,
                    `記事がmanifestに登録されていません: ${source}`,
                ),
            );
        }
    }
}

function validateManifestHistory(
    previousManifest: unknown,
    currentManifest: unknown,
    diagnostics: Diagnostic[],
    previousFile = 'previous-manifest.json',
): void {
    if (
        !isPlainObject(previousManifest) ||
        previousManifest.schema_version !== 1 ||
        !Array.isArray(previousManifest.articles)
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_PREVIOUS_MANIFEST',
                previousFile,
                'previous manifestはschema_version 1のarticles配列を持つ必要があります。',
            ),
        );
        return;
    }

    if (
        !isPlainObject(currentManifest) ||
        !Array.isArray(currentManifest.articles)
    ) {
        return;
    }

    const currentById = new Map<string, UnknownRecord>();
    const currentBySource = new Map<string, UnknownRecord>();
    for (const entry of currentManifest.articles) {
        if (!isPlainObject(entry)) {
            continue;
        }
        if (
            typeof entry.article_id === 'string' &&
            ARTICLE_ID_PATTERN.test(entry.article_id)
        ) {
            currentById.set(entry.article_id, entry);
        }
        if (typeof entry.source === 'string') {
            currentBySource.set(normalizePath(entry.source), entry);
        }
    }

    const previousIds = new Set<string>();
    for (const entry of previousManifest.articles) {
        if (
            isPlainObject(entry)
            && typeof entry.article_id === 'string'
            && ARTICLE_ID_PATTERN.test(entry.article_id)
        ) {
            previousIds.add(entry.article_id);
        }
    }
    for (const articleId of currentById.keys()) {
        if (!previousIds.has(articleId)) {
            diagnostics.push(
                createDiagnostic(
                    'UNSUPPORTED_MANIFEST_ARTICLE_ADDITION',
                    previousFile,
                    `新しいarticle_id「${articleId}」はまだ自動配信へ追加できません。Qiitaの作成・再実行安全プロトコルを整備してからonboardingしてください。`,
                ),
            );
        }
    }

    for (const previousEntry of previousManifest.articles) {
        if (
            !isPlainObject(previousEntry) ||
            typeof previousEntry.article_id !== 'string' ||
            !ARTICLE_ID_PATTERN.test(previousEntry.article_id)
        ) {
            continue;
        }

        const currentEntry = currentById.get(previousEntry.article_id);
        if (!currentEntry) {
            diagnostics.push(
                createDiagnostic(
                    'MANIFEST_ARTICLE_REMOVED',
                    previousFile,
                    `既存article_id「${previousEntry.article_id}」がmanifestから消えています。retiring/retiredでも同じIDのentryを保持してください。`,
                ),
            );
            continue;
        }

        if (typeof previousEntry.source === 'string') {
            const previousSource = normalizePath(previousEntry.source);
            const reboundEntry = currentBySource.get(previousSource);
            if (
                reboundEntry &&
                reboundEntry.article_id !== previousEntry.article_id
            ) {
                diagnostics.push(
                    createDiagnostic(
                        'MANIFEST_SOURCE_REBOUND',
                        previousFile,
                        `既存source「${previousSource}」がarticle_id「${previousEntry.article_id}」から「${reboundEntry.article_id}」へ付け替えられています。`,
                    ),
                );
            }
        }

        if (
            isPlainObject(previousEntry.targets) &&
            isPlainObject(currentEntry.targets)
        ) {
            for (const platform of Object.keys(previousEntry.targets)) {
                if (
                    PLATFORMS.includes(platform as Platform) &&
                    !Object.prototype.hasOwnProperty.call(
                        currentEntry.targets,
                        platform,
                    )
                ) {
                    diagnostics.push(
                        createDiagnostic(
                            'MANIFEST_TARGET_REMOVED',
                            previousFile,
                            `article_id「${previousEntry.article_id}」の既存target「${platform}」が消えています。desired: withdrawnとして保持してください。`,
                        ),
                    );
                }
            }
        }
    }
}

export interface ArticleValidationManifestExports {
    validateManifest: typeof validateManifest;
    validateManifestHistory: typeof validateManifestHistory;
}

module.exports = {
    validateManifest,
    validateManifestHistory,
};
