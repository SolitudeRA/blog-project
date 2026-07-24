'use strict';

import type {
    Diagnostic,
    ParsedArticle,
    Platform,
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
} = require('./constants.ts') as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    collisionKey,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;

function buildEffectiveArticles(
    articles: ParsedArticle[],
    platform: Platform,
    diagnostics: Diagnostic[],
): ParsedArticle[] {
    const effective = new Map<string, ParsedArticle>();

    for (const article of articles.filter((item) => item.source === 'share')) {
        effective.set(collisionKey(article.sourceRelativePath), article);
    }

    for (const article of articles.filter((item) => item.source === platform)) {
        const key = collisionKey(article.sourceRelativePath);
        const shared = effective.get(key);
        if (shared) {
            diagnostics.push(
                createDiagnostic(
                    'PLATFORM_OVERRIDE_CONFLICT',
                    article.relativePath,
                    `${platform}固有記事が同じ相対パスの共有記事 ${shared.relativePath} を上書きします。`,
                ),
            );
        }
        effective.set(key, article);
    }

    return [...effective.values()].sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath),
    );
}

function validateFilenameCollisions(
    articles: ParsedArticle[],
    diagnostics: Diagnostic[],
): void {
    const filesByKey = new Map<string, ParsedArticle[]>();

    for (const article of articles) {
        const key = `${article.source}:${collisionKey(
            article.sourceRelativePath,
        )}`;
        const matches = filesByKey.get(key) || [];
        matches.push(article);
        filesByKey.set(key, matches);
    }

    for (const matches of filesByKey.values()) {
        if (matches.length > 1) {
            diagnostics.push(
                createDiagnostic(
                    'FILENAME_COLLISION',
                    matches[0].relativePath,
                    `大文字小文字・NFC正規化後に同じになるファイル名が重複しています: ${matches
                        .map((article) => article.relativePath)
                        .join(', ')}`,
                ),
            );
        }
    }
}

function requireLocalUpdatedAt(
    article: ParsedArticle,
    diagnostics: Diagnostic[],
    seen: Set<string>,
): void {
    if (article.localUpdatedAt !== undefined) {
        return;
    }

    const key = `MISSING_LOCAL_UPDATED_AT:${article.relativePath}`;
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    diagnostics.push(
        createDiagnostic(
            'MISSING_LOCAL_UPDATED_AT',
            article.relativePath,
            'Qiitaへの配信にはlocal_updated_atが必要です。',
        ),
    );
}

function validatePlatformIdentity(
    platform: Platform,
    articles: ParsedArticle[],
    diagnostics: Diagnostic[],
): void {
    const titleMap = new Map<string, ParsedArticle[]>();
    const articleIdMap = new Map<string, ParsedArticle[]>();

    for (const article of articles) {
        if (article.title) {
            const titleMatches = titleMap.get(article.title) || [];
            titleMatches.push(article);
            titleMap.set(article.title, titleMatches);
        }
        if (article.articleId && ARTICLE_ID_PATTERN.test(article.articleId)) {
            const idMatches = articleIdMap.get(article.articleId) || [];
            idMatches.push(article);
            articleIdMap.set(article.articleId, idMatches);
        }
    }

    for (const [title, matches] of titleMap) {
        if (matches.length > 1) {
            diagnostics.push(
                createDiagnostic(
                    'DUPLICATE_TITLE',
                    matches[0].relativePath,
                    `${platform}の有効記事集合でtitle「${title}」が重複しています: ${matches
                        .map((article) => article.relativePath)
                        .join(', ')}`,
                ),
            );
        }
    }

    for (const article of articles) {
        for (const reference of article.references) {
            if (!reference.articleId) {
                continue;
            }
            const matches = articleIdMap.get(reference.articleId) || [];
            if (matches.length === 0) {
                diagnostics.push(
                    createDiagnostic(
                        'UNRESOLVED_ARTICLE_REFERENCE',
                        article.relativePath,
                        `${platform}の有効記事集合にarticle_id「${reference.articleId}」がありません。`,
                    ),
                );
            } else if (matches.length > 1) {
                diagnostics.push(
                    createDiagnostic(
                        'AMBIGUOUS_ARTICLE_REFERENCE',
                        article.relativePath,
                        `${platform}のarticle_id「${reference.articleId}」を一意に決定できません。`,
                    ),
                );
            }
        }
    }
}

function validateArticleIds(
    articles: ParsedArticle[],
    diagnostics: Diagnostic[],
): void {
    const articlesById = new Map<string, ParsedArticle[]>();

    for (const article of articles) {
        if (!article.articleId || !ARTICLE_ID_PATTERN.test(article.articleId)) {
            continue;
        }
        const matches = articlesById.get(article.articleId) || [];
        matches.push(article);
        articlesById.set(article.articleId, matches);
    }

    for (const [articleId, matches] of articlesById) {
        if (matches.length > 1) {
            diagnostics.push(
                createDiagnostic(
                    'DUPLICATE_ARTICLE_ID',
                    matches[0].relativePath,
                    `article_id「${articleId}」が重複しています: ${matches
                        .map((article) => article.relativePath)
                        .join(', ')}`,
                ),
            );
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePlatformSeries(
    platform: Platform,
    articles: ParsedArticle[],
    diagnostics: Diagnostic[],
): void {
    const seriesMap = new Map<string, ParsedArticle[]>();

    for (const article of articles) {
        if (!article.series) {
            continue;
        }
        const matches = seriesMap.get(article.series) || [];
        matches.push(article);
        seriesMap.set(article.series, matches);
    }

    for (const [series, matches] of seriesMap) {
        const titlePattern = new RegExp(
            `^${escapeRegExp(series)} #(\\d+)\\s+\\S[\\s\\S]*$`,
            'u',
        );
        const numbered: Array<{ article: ParsedArticle; number: bigint }> = [];
        const unnumbered: ParsedArticle[] = [];

        for (const article of matches) {
            const match = article.title && article.title.match(titlePattern);
            if (!match) {
                unnumbered.push(article);
            } else {
                numbered.push({
                    article,
                    number: BigInt(match[1]),
                });
            }
        }

        if (numbered.length > 0 && unnumbered.length > 0) {
            for (const article of unnumbered) {
                diagnostics.push(
                    createDiagnostic(
                        'SERIES_TITLE_FORMAT',
                        article.relativePath,
                        `${platform}の番号付きseries記事タイトルは「${series} #整数 ...」形式に統一してください。`,
                    ),
                );
            }
            diagnostics.push(
                createDiagnostic(
                    'MIXED_SERIES_NUMBERING',
                    matches[0].relativePath,
                    `${platform}のseries「${series}」で番号付き・番号なしタイトルが混在しています。`,
                ),
            );
        }

        const byNumber = new Map<bigint, ParsedArticle[]>();
        for (const item of numbered) {
            const sameNumber = byNumber.get(item.number) || [];
            sameNumber.push(item.article);
            byNumber.set(item.number, sameNumber);
        }

        for (const [number, sameNumber] of byNumber) {
            if (sameNumber.length > 1) {
                diagnostics.push(
                    createDiagnostic(
                        'DUPLICATE_SERIES_NUMBER',
                        sameNumber[0].relativePath,
                        `${platform}のseries「${series}」で #${number.toString()} が重複しています: ${sameNumber
                            .map((article) => article.relativePath)
                            .join(', ')}`,
                    ),
                );
            }
        }

        const numbers = [...byNumber.keys()].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
        );
        if (numbers.length > 1) {
            const missing: string[] = [];
            for (let index = 1; index < numbers.length; index += 1) {
                const firstMissing = numbers[index - 1] + 1n;
                const lastMissing = numbers[index] - 1n;
                if (firstMissing <= lastMissing) {
                    missing.push(
                        firstMissing === lastMissing
                            ? `#${firstMissing.toString()}`
                            : `#${firstMissing.toString()}-#${lastMissing.toString()}`,
                    );
                }
            }
            if (missing.length > 0) {
                diagnostics.push(
                    createDiagnostic(
                        'SERIES_NUMBER_GAP',
                        matches[0].relativePath,
                        `${platform}のseries「${series}」に内部欠番があります: ${missing.join(
                            ', ',
                        )}`,
                    ),
                );
            }
        }
    }
}

export interface ArticleValidationArticleSetExports {
    buildEffectiveArticles: typeof buildEffectiveArticles;
    requireLocalUpdatedAt: typeof requireLocalUpdatedAt;
    validateArticleIds: typeof validateArticleIds;
    validateFilenameCollisions: typeof validateFilenameCollisions;
    validatePlatformIdentity: typeof validatePlatformIdentity;
    validatePlatformSeries: typeof validatePlatformSeries;
}

module.exports = {
    buildEffectiveArticles,
    requireLocalUpdatedAt,
    validateArticleIds,
    validateFilenameCollisions,
    validatePlatformIdentity,
    validatePlatformSeries,
};
