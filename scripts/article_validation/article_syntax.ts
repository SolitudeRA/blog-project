'use strict';

import type {
    ArticleReference,
    Diagnostic,
} from './types.ts';
import type {
    ArticleValidationConstantsExports,
} from './constants.ts';
import type {
    ArticleValidationDiagnosticsExports,
} from './diagnostics.ts';

const { TextDecoder }: typeof import('node:util') = require('node:util');
const {
    SERIES_END,
    SERIES_START,
    TIMESTAMP_WITH_ZONE,
} = require('./constants.ts') as ArticleValidationConstantsExports;
const {
    createDiagnostic,
} = require('./diagnostics.ts') as ArticleValidationDiagnosticsExports;

function countOccurrences(content: string, needle: string): number {
    let count = 0;
    let offset = 0;

    while ((offset = content.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }

    return count;
}

function analyzeArticleReferences(
    content: string,
    file = '(content)',
): { references: ArticleReference[]; diagnostics: Diagnostic[] } {
    const references: ArticleReference[] = [];
    const diagnostics: Diagnostic[] = [];
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

function extractArticleReferences(content: string): ArticleReference[] {
    return analyzeArticleReferences(content).references;
}

function isTimestampWithTimezone(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        TIMESTAMP_WITH_ZONE.test(value) &&
        !Number.isNaN(Date.parse(value))
    );
}

function isTrimmedNfcString(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value === value.trim() &&
        value === value.normalize('NFC')
    );
}

function validateBytes(buffer: Uint8Array, file: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

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

function validateSeriesMarkers(content: string, file: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
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

function decodeUtf8(
    bytes: string | Uint8Array | null | undefined,
): { buffer: Buffer; content: string } {
    const buffer =
        typeof bytes === 'string'
            ? Buffer.from(bytes, 'utf8')
            : Buffer.from(bytes ?? []);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { buffer, content: decoder.decode(buffer) };
}

export interface ArticleValidationSyntaxExports {
    analyzeArticleReferences: typeof analyzeArticleReferences;
    decodeUtf8: typeof decodeUtf8;
    extractArticleReferences: typeof extractArticleReferences;
    isTimestampWithTimezone: typeof isTimestampWithTimezone;
    isTrimmedNfcString: typeof isTrimmedNfcString;
    validateBytes: typeof validateBytes;
    validateSeriesMarkers: typeof validateSeriesMarkers;
}

module.exports = {
    analyzeArticleReferences,
    decodeUtf8,
    extractArticleReferences,
    isTimestampWithTimezone,
    isTrimmedNfcString,
    validateBytes,
    validateSeriesMarkers,
};
