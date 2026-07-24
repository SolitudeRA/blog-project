'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const matter = require('gray-matter');

const SOURCE_KINDS = new Set(['share', 'qiita', 'zenn']);
const PLATFORMS = ['qiita', 'zenn'];
const SERIES_START = '<!-- START_SERIES -->';
const SERIES_END = '<!-- END_SERIES -->';
const ARTICLE_ID_PATTERN = /^[0-9a-f]{32}$/;
const ARTICLE_STATES = new Set(['active', 'retiring', 'retired']);
const TARGET_DESIRED_STATES = new Set(['published', 'withdrawn']);
const TIMESTAMP_WITH_ZONE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function createDiagnostic(code, file, message) {
    return { code, file, message };
}

function normalizePath(filePath) {
    return filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function collisionKey(filePath) {
    return normalizePath(filePath).normalize('NFC').toLowerCase();
}

function countOccurrences(content, needle) {
    let count = 0;
    let offset = 0;

    while ((offset = content.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }

    return count;
}

function analyzeArticleReferences(content, file = '(content)') {
    const references = [];
    const diagnostics = [];
    let offset = 0;

    while (offset < content.length) {
        const openIndex = content.indexOf('<<<', offset);
        const closeIndex = content.indexOf('>>>', offset);

        if (closeIndex !== -1 && (openIndex === -1 || closeIndex < openIndex)) {
            diagnostics.push(
                createDiagnostic(
                    'MALFORMED_ARTICLE_REFERENCE',
                    file,
                    `対応する開始記号がない >>> を offset ${closeIndex} で検出しました。`,
                ),
            );
            offset = closeIndex + 3;
            continue;
        }

        if (openIndex === -1) {
            break;
        }

        const matchingClose = content.indexOf('>>>', openIndex + 3);
        if (matchingClose === -1) {
            diagnostics.push(
                createDiagnostic(
                    'MALFORMED_ARTICLE_REFERENCE',
                    file,
                    `閉じられていない <<< を offset ${openIndex} で検出しました。`,
                ),
            );
            break;
        }

        const rawReference = content.slice(openIndex + 3, matchingClose);
        const malformed =
            (openIndex > 0 && content[openIndex - 1] === '<') ||
            content[matchingClose + 3] === '>' ||
            rawReference.trim().length === 0 ||
            /[<>\r\n]/.test(rawReference) ||
            rawReference !== rawReference.trim();

        if (malformed) {
            diagnostics.push(
                createDiagnostic(
                    'MALFORMED_ARTICLE_REFERENCE',
                    file,
                    `<<<article:article_id>>> 形式ではない参照を offset ${openIndex} で検出しました。`,
                ),
            );
            offset = matchingClose + 3;
            continue;
        }

        const match = rawReference.match(
            /^article:([0-9a-f]{32})$/,
        );
        if (match) {
            references.push({
                articleId: match[1],
                index: openIndex,
            });
        } else if (rawReference.startsWith('article:')) {
            diagnostics.push(
                createDiagnostic(
                    'INVALID_ARTICLE_REFERENCE',
                    file,
                    `参照のarticle_idが32桁の小文字16進数ではありません: ${rawReference}`,
                ),
            );
        } else {
            diagnostics.push(
                createDiagnostic(
                    'LEGACY_TITLE_REFERENCE',
                    file,
                    `タイトル参照 <<<${rawReference}>>> は禁止されています。<<<article:32hex-id>>> を使用してください。`,
                ),
            );
        }
        offset = matchingClose + 3;
    }

    return { references, diagnostics };
}

function extractArticleReferences(content) {
    return analyzeArticleReferences(content).references;
}

function isTimestampWithTimezone(value) {
    return (
        typeof value === 'string' &&
        TIMESTAMP_WITH_ZONE.test(value) &&
        !Number.isNaN(Date.parse(value))
    );
}

function isTrimmedNfcString(value) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value === value.trim() &&
        value === value.normalize('NFC')
    );
}

function validateBytes(buffer, file) {
    const diagnostics = [];

    if (
        buffer.length >= 3 &&
        buffer[0] === 0xef &&
        buffer[1] === 0xbb &&
        buffer[2] === 0xbf
    ) {
        diagnostics.push(
            createDiagnostic(
                'UTF8_BOM',
                file,
                'UTF-8 BOMは許可されていません。',
            ),
        );
    }

    let nulCount = 0;
    let firstNulOffset = -1;
    for (let index = 0; index < buffer.length; index += 1) {
        const byte = buffer[index];
        if (byte === 0) {
            nulCount += 1;
            if (firstNulOffset === -1) {
                firstNulOffset = index;
            }
        } else if (
            byte < 0x20 &&
            byte !== 0x09 &&
            byte !== 0x0a &&
            byte !== 0x0d
        ) {
            diagnostics.push(
                createDiagnostic(
                    'C0_CONTROL_BYTE',
                    file,
                    `許可されていないC0制御バイト 0x${byte
                        .toString(16)
                        .padStart(2, '0')} を offset ${index} で検出しました。`,
                ),
            );
        }
    }

    if (nulCount > 0) {
        diagnostics.push(
            createDiagnostic(
                'NUL_BYTE',
                file,
                `NULバイトを ${nulCount} 個検出しました（最初の offset: ${firstNulOffset}）。`,
            ),
        );
    }

    return diagnostics;
}

function validateSeriesMarkers(content, file) {
    const diagnostics = [];
    const startCount = countOccurrences(content, SERIES_START);
    const endCount = countOccurrences(content, SERIES_END);

    if (startCount !== endCount) {
        diagnostics.push(
            createDiagnostic(
                'SERIES_MARKER_MISMATCH',
                file,
                `${SERIES_START} と ${SERIES_END} の数が一致しません。`,
            ),
        );
        return diagnostics;
    }

    if (startCount > 1) {
        diagnostics.push(
            createDiagnostic(
                'SERIES_MARKER_MULTIPLE',
                file,
                'シリーズリンクブロックは1記事につき最大1組です。',
            ),
        );
        return diagnostics;
    }

    if (
        startCount === 1 &&
        content.indexOf(SERIES_START) > content.indexOf(SERIES_END)
    ) {
        diagnostics.push(
            createDiagnostic(
                'SERIES_MARKER_ORDER',
                file,
                'シリーズリンクブロックの終了マーカーが開始マーカーより前にあります。',
            ),
        );
    }

    return diagnostics;
}

function decodeUtf8(bytes) {
    const buffer =
        typeof bytes === 'string'
            ? Buffer.from(bytes, 'utf8')
            : Buffer.from(bytes ?? []);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { buffer, content: decoder.decode(buffer) };
}

function parseArticle(input) {
    const relativePath = normalizePath(input.relativePath || '');
    const pathParts = relativePath.split('/');
    const source = pathParts[0];
    const diagnostics = [];

    if (!SOURCE_KINDS.has(source) || pathParts.length < 2) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_SOURCE_PATH',
                relativePath || '(unknown)',
                '記事は share、qiita、zenn のいずれかのディレクトリに配置してください。',
            ),
        );
        return { article: null, diagnostics };
    }

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

    let decoded;
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

    let parsed;
    try {
        parsed = matter(content);
    } catch (error) {
        diagnostics.push(
            createDiagnostic(
                'INVALID_FRONT_MATTER',
                relativePath,
                `YAML front matterを解析できません: ${error.message}`,
            ),
        );
        return { article: null, diagnostics };
    }

    if (parsed.isEmpty || !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)) {
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

    const data = parsed.data || {};
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
        !['tech', 'idea'].includes(data.type)
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

function buildEffectiveArticles(articles, platform, diagnostics) {
    const effective = new Map();

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

function validateFilenameCollisions(articles, diagnostics) {
    const filesByKey = new Map();

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

function requireLocalUpdatedAt(article, diagnostics, seen) {
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

function validatePlatformIdentity(platform, articles, diagnostics) {
    const titleMap = new Map();
    const articleIdMap = new Map();

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

function validateArticleIds(articles, diagnostics) {
    const articlesById = new Map();

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

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePlatformSeries(platform, articles, diagnostics) {
    const seriesMap = new Map();

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
        const numbered = [];
        const unnumbered = [];

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

        const byNumber = new Map();
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
            const missing = [];
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

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function expectedTargetsForSource(source) {
    if (source === 'share') {
        return ['qiita', 'zenn'];
    }
    if (source === 'qiita' || source === 'zenn') {
        return [source];
    }
    return [];
}

function validateManifest(
    manifest,
    articles,
    diagnostics,
    manifestFile = 'manifest.json',
) {
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
    const manifestBySource = new Map();
    const manifestById = new Map();

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

        if (!ARTICLE_STATES.has(entry.article_state)) {
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
        let sourceKind = null;
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
                sourceKind = sourceMatch[1];
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
                targetKeys.some((platform) => !PLATFORMS.includes(platform))
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
                    !TARGET_DESIRED_STATES.has(target.desired)
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
    previousManifest,
    currentManifest,
    diagnostics,
    previousFile = 'previous-manifest.json',
) {
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

    const currentById = new Map();
    const currentBySource = new Map();
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

    const previousIds = new Set(
        previousManifest.articles
            .filter(
                (entry) =>
                    isPlainObject(entry) &&
                    typeof entry.article_id === 'string' &&
                    ARTICLE_ID_PATTERN.test(entry.article_id),
            )
            .map((entry) => entry.article_id),
    );
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
                    PLATFORMS.includes(platform) &&
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

function validateArticleFiles(files, options = {}) {
    const phase = options.phase || 'source';
    if (!['source', 'distribution'].includes(phase)) {
        throw new TypeError(`Unknown validation phase: ${phase}`);
    }

    const diagnostics = [];
    const articles = [];
    const sortedFiles = [...files].sort((a, b) =>
        normalizePath(a.relativePath).localeCompare(
            normalizePath(b.relativePath),
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

    const effective = {};
    for (const platform of PLATFORMS) {
        effective[platform] = buildEffectiveArticles(
            articles,
            platform,
            diagnostics,
        );
        validatePlatformIdentity(platform, effective[platform], diagnostics);
        validatePlatformSeries(platform, effective[platform], diagnostics);
    }

    const timestampDiagnostics = new Set();
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

function collectMarkdownFiles(articlesRoot, diagnostics = []) {
    const files = [];

    for (const source of SOURCE_KINDS) {
        const directory = path.join(articlesRoot, source);
        let directoryStat;
        try {
            directoryStat = fs.lstatSync(directory);
        } catch (error) {
            if (error.code === 'ENOENT') {
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

function readManifestFile(articlesRoot, diagnostics) {
    const manifestPath = path.join(articlesRoot, 'manifest.json');
    const diagnosticPath = 'manifest.json';
    let manifestStat;

    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
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
                `manifest.jsonを解析できません: ${error.message}`,
            ),
        );
        return null;
    }
}

function readPreviousManifestFile(manifestPath, diagnostics) {
    const diagnosticPath = normalizePath(manifestPath);
    let manifestStat;

    try {
        manifestStat = fs.lstatSync(manifestPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
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
                `previous manifestを解析できません: ${error.message}`,
            ),
        );
        return null;
    }
}

function validateArticlesDirectory(articlesRoot, options = {}) {
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

    const structureDiagnostics = [];
    const files = collectMarkdownFiles(articlesRoot, structureDiagnostics);
    const manifest = readManifestFile(articlesRoot, structureDiagnostics);
    const validationOptions = {
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

function formatResult(result) {
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

function parseCliArgs(argv) {
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

    return { articlesRoot, phase, previousManifestPath };
}

function runCli(argv = process.argv.slice(2), io = console) {
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
        io.error(`Article validation could not run: ${error.message}`);
        return 2;
    }
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
