'use strict';

import type {
    ArticleInput,
    Diagnostic,
    ParseArticleResult,
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
import type {
    ArticleValidationSyntaxExports,
} from './article_syntax.ts';

const matter: typeof import('gray-matter') = require('gray-matter');
const {
    ARTICLE_ID_PATTERN,
    SOURCE_KINDS,
} = require('./constants.ts') as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;
const {
    normalizePath,
} = require('./normalization.ts') as ArticleValidationNormalizationExports;
const {
    analyzeArticleReferences,
    decodeUtf8,
    isTimestampWithTimezone,
    isTrimmedNfcString,
    validateBytes,
    validateSeriesMarkers,
} = require('./article_syntax.ts') as ArticleValidationSyntaxExports;

function parseArticle(input: ArticleInput): ParseArticleResult {
    const relativePath = normalizePath(input.relativePath || '');
    const pathParts = relativePath.split('/');
    const rawSource = pathParts[0];
    const diagnostics: Diagnostic[] = [];

    if (!SOURCE_KINDS.has(rawSource as SourceKind) || pathParts.length < 2) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_SOURCE_PATH',
                relativePath || '(unknown)',
                '記事は share、qiita、zenn のいずれかのディレクトリに配置してください。',
            ),
        );
        return { article: null, diagnostics };
    }
    const source = rawSource as SourceKind;

    const buffer =
        typeof input.bytes === 'string'
            ? Buffer.from(input.bytes, 'utf8')
            : Buffer.from(input.bytes ?? []);

    if (buffer.length === 0) {
        diagnostics.push(
            createDiagnostic(
                'EMPTY_FILE',
                relativePath,
                '空の記事は配信先の既存記事を壊す可能性があるため公開できません。',
            ),
        );
        return { article: null, diagnostics };
    }

    const byteDiagnostics = validateBytes(buffer, relativePath);
    if (byteDiagnostics.length > 0) {
        diagnostics.push(...byteDiagnostics);
        return { article: null, diagnostics };
    }

    let decoded: { buffer: Buffer; content: string };
    try {
        decoded = decodeUtf8(buffer);
    } catch {
        diagnostics.push(
            createDiagnostic(
                'INVALID_UTF8',
                relativePath,
                'ファイルを厳密なUTF-8として読み取れません。',
            ),
        );
        return { article: null, diagnostics };
    }

    if (decoded.content.trim().length === 0) {
        diagnostics.push(
            createDiagnostic(
                'EMPTY_FILE',
                relativePath,
                '空の記事は配信先の既存記事を壊す可能性があるため公開できません。',
            ),
        );
        return { article: null, diagnostics };
    }

    const content = decoded.content;
    const firstLine = content.split(/\r?\n/, 1)[0];
    if (firstLine !== '---') {
        diagnostics.push(
            createDiagnostic(
                'MISSING_FRONT_MATTER',
                relativePath,
                '記事の先頭にYAML front matterがありません。',
            ),
        );
        return { article: null, diagnostics };
    }

    let parsed: ReturnType<typeof matter>;
    try {
        parsed = matter(content);
    } catch (error) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_FRONT_MATTER',
                relativePath,
                `YAML front matterを解析できません: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            ),
        );
        return { article: null, diagnostics };
    }

    if (
        (parsed as typeof parsed & { isEmpty?: boolean }).isEmpty
        || !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_FRONT_MATTER',
                relativePath,
                'front matterの終了区切り（---）が見つかりません。',
            ),
        );
        return { article: null, diagnostics };
    }

    if (parsed.content.trim().length === 0) {
        diagnostics.push(
            createDiagnostic(
                'EMPTY_BODY',
                relativePath,
                'front matter以外の記事本文が空です。',
            ),
        );
    }

    const data = (parsed.data || {}) as UnknownRecord;
    const articleId =
        typeof data.article_id === 'string' ? data.article_id : null;
    const title =
        typeof data.title === 'string' && data.title.trim()
            ? data.title.trim()
            : null;

    if (articleId === null) {
        diagnostics.push(
            createDiagnostic(
                'MISSING_ARTICLE_ID',
                relativePath,
                'front matterにarticle_idが必要です。',
            ),
        );
    } else if (!ARTICLE_ID_PATTERN.test(articleId)) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_ARTICLE_ID',
                relativePath,
                'article_idは32桁の小文字16進数にしてください。',
            ),
        );
    }

    if (!title) {
        diagnostics.push(
            createDiagnostic(
                'MISSING_TITLE',
                relativePath,
                'front matterに空でないtitleが必要です。',
            ),
        );
    } else if (!isTrimmedNfcString(data.title)) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_TITLE',
                relativePath,
                'titleは前後に空白がないNFC正規化済み文字列にしてください。',
            ),
        );
    }

    if (Object.prototype.hasOwnProperty.call(data, 'topics')) {
        diagnostics.push(
            createDiagnostic(
                'DEPRECATED_TOPICS',
                relativePath,
                'ソース記事ではtopicsではなくtagsを使用してください。',
            ),
        );
    }

    const tagsValid =
        Array.isArray(data.tags) &&
        data.tags.length > 0 &&
        data.tags.every(
            (tag) =>
                isTrimmedNfcString(tag),
        ) &&
        new Set(data.tags).size === data.tags.length;

    if (!tagsValid) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_TAGS',
                relativePath,
                'tagsは重複のない、前後空白なし・NFC正規化済み文字列の配列にしてください。',
            ),
        );
    }

    if (
        data.series !== undefined &&
        data.series !== null &&
        !isTrimmedNfcString(data.series)
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_SERIES',
                relativePath,
                'seriesはnull、未指定、または前後空白なし・NFC正規化済み文字列にしてください。',
            ),
        );
    }

    if (
        data.emoji !== undefined &&
        !isTrimmedNfcString(data.emoji)
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_EMOJI',
                relativePath,
                'emojiは前後空白なし・NFC正規化済みの空でない文字列にしてください。',
            ),
        );
    }

    if (
        data.type !== undefined &&
        (typeof data.type !== 'string' || !['tech', 'idea'].includes(data.type))
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_TYPE',
                relativePath,
                'typeはtechまたはideaにしてください。',
            ),
        );
    }

    if (data.published !== undefined && typeof data.published !== 'boolean') {
        diagnostics.push(
            createDiagnostic(
                'INVALID_PUBLISHED',
                relativePath,
                'publishedはbooleanにしてください。',
            ),
        );
    }

    if (
        data.local_updated_at !== undefined &&
        !isTimestampWithTimezone(data.local_updated_at)
    ) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_LOCAL_UPDATED_AT',
                relativePath,
                'local_updated_atはタイムゾーン付きISO 8601文字列にしてください。',
            ),
        );
    }

    diagnostics.push(...validateSeriesMarkers(parsed.content, relativePath));

    const referenceAnalysis = analyzeArticleReferences(
        parsed.content,
        relativePath,
    );
    diagnostics.push(...referenceAnalysis.diagnostics);
    const references = referenceAnalysis.references;
    if (
        references.length > 0 &&
        (typeof data.series !== 'string' || data.series.trim().length === 0)
    ) {
        diagnostics.push(
            createDiagnostic(
                'REFERENCE_REQUIRES_SERIES',
                relativePath,
                '<<<article:article_id>>> 参照を使う記事にはseriesが必要です。',
            ),
        );
    }

    return {
        article: {
            relativePath,
            source,
            sourceRelativePath: pathParts.slice(1).join('/'),
            articleId,
            title,
            series:
                typeof data.series === 'string' ? data.series.trim() : null,
            localUpdatedAt: data.local_updated_at,
            references,
        },
        diagnostics,
    };
}

export interface ArticleValidationArticleExports {
    parseArticle: typeof parseArticle;
}

module.exports = {
    parseArticle,
};
