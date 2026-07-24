'use strict';

import type {
    ArticleInput,
    Diagnostic,
    UnknownRecord,
    ValidateArticlesExports,
    ValidationResult,
} from '../scripts/validate_articles.ts';
import type {
    ResolveManifestHistoryExports,
} from '../scripts/resolve_manifest_history.ts';
import type {
    ArticleValidationArticleSetExports,
} from '../scripts/article_validation/article_set.ts';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto: typeof import('node:crypto') = require('node:crypto');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const test: typeof import('node:test') = require('node:test');

const validatorApi =
    require('../scripts/validate_articles.ts') as ValidateArticlesExports;
const articleApi =
    require('../scripts/article_validation/article.ts') as Pick<
        ValidateArticlesExports,
        'parseArticle'
    >;
const articleSetApi =
    require(
        '../scripts/article_validation/article_set.ts'
    ) as ArticleValidationArticleSetExports;
const {
    parseCliArgs,
    runCli,
    validateArticleFiles,
    validateArticlesDirectory,
} = validatorApi;
const {
    defaultGitRunner,
    loadPreviousManifestFromGit,
} = require('../scripts/resolve_manifest_history.ts') as ResolveManifestHistoryExports;

interface MarkdownOptions {
    articleId?: string;
    title?: string;
    tags?: string[];
    series?: string | null;
    localUpdatedAt?: string;
    extra?: string;
    body?: string;
}

interface TestArticleInput extends ArticleInput {
    relativePath: string;
    bytes: Buffer;
}

interface ManifestTarget {
    desired: string;
}

interface ManifestEntry extends UnknownRecord {
    article_id: string;
    source: string | null;
    article_state: string;
    targets: Record<string, ManifestTarget>;
}

interface TestManifest {
    schema_version: number;
    articles: ManifestEntry[];
}

test('validate_articles keeps its CommonJS compatibility surface', () => {
    assert.equal(validatorApi.parseArticle, articleApi.parseArticle);
    assert.deepEqual(Object.keys(validatorApi).sort(), [
        'ARTICLE_ID_PATTERN',
        'SERIES_END',
        'SERIES_START',
        'collectMarkdownFiles',
        'extractArticleReferences',
        'formatResult',
        'isTimestampWithTimezone',
        'parseArticle',
        'parseCliArgs',
        'readManifestFile',
        'readPreviousManifestFile',
        'runCli',
        'validateArticleFiles',
        'validateArticlesDirectory',
        'validateManifest',
        'validateManifestHistory',
        'validateSeriesMarkers',
    ]);

    assert.equal(validatorApi.SERIES_START, '<!-- START_SERIES -->');
    assert.equal(validatorApi.SERIES_END, '<!-- END_SERIES -->');
    assert.equal(validatorApi.ARTICLE_ID_PATTERN.test('a'.repeat(32)), true);
    assert.deepEqual(
        validatorApi.extractArticleReferences(
            `<<<article:${'a'.repeat(32)}>>>`,
        ),
        [{ articleId: 'a'.repeat(32), index: 0 }],
    );
    assert.equal(
        validatorApi.isTimestampWithTimezone(
            '2026-07-24T12:00:00+09:00',
        ),
        true,
    );
    assert.deepEqual(
        validatorApi.validateSeriesMarkers(
            '<!-- START_SERIES -->\n<!-- END_SERIES -->',
            'share/a.md',
        ),
        [],
    );
});

test('article_set keeps its internal surface and diagnoses ambiguous references', () => {
    assert.deepEqual(Object.keys(articleSetApi).sort(), [
        'buildEffectiveArticles',
        'requireLocalUpdatedAt',
        'validateArticleIds',
        'validateFilenameCollisions',
        'validatePlatformIdentity',
        'validatePlatformSeries',
    ]);

    const duplicateArticleId = 'b'.repeat(32);
    const parsedArticles = [
        article(
            'share/first.md',
            markdown({
                articleId: duplicateArticleId,
                title: 'First',
            }),
        ),
        article(
            'share/second.md',
            markdown({
                articleId: duplicateArticleId,
                title: 'Second',
            }),
        ),
        article(
            'share/reference.md',
            markdown({
                title: 'Series #0 Reference',
                series: 'Series',
                body: `<<<article:${duplicateArticleId}>>>`,
            }),
        ),
    ].map((input) => {
        const result = validatorApi.parseArticle(input);
        assert.deepEqual(result.diagnostics, []);
        assert.ok(result.article);
        return result.article;
    });
    const diagnostics: Diagnostic[] = [];

    articleSetApi.validatePlatformIdentity(
        'qiita',
        parsedArticles,
        diagnostics,
    );

    assert.deepEqual(diagnostics, [
        {
            code: 'AMBIGUOUS_ARTICLE_REFERENCE',
            file: 'share/reference.md',
            message:
                `qiitaのarticle_id「${duplicateArticleId}」を一意に決定できません。`,
        },
    ]);
});

function markdown({
    articleId,
    title = '記事A',
    tags = ['nodejs'],
    series,
    localUpdatedAt,
    extra = '',
    body = '# 本文',
}: MarkdownOptions = {}): string {
    const lines = [
        '---',
    ];
    if (articleId !== undefined) {
        lines.push(`article_id: ${JSON.stringify(articleId)}`);
    }
    lines.push(
        `title: ${JSON.stringify(title)}`,
        'tags:',
        ...tags.map((tag) => `  - ${JSON.stringify(tag)}`),
    );
    if (series !== undefined) {
        lines.push(`series: ${series === null ? 'null' : JSON.stringify(series)}`);
    }
    if (localUpdatedAt !== undefined) {
        lines.push(`local_updated_at: ${JSON.stringify(localUpdatedAt)}`);
    }
    if (extra) {
        lines.push(extra);
    }
    lines.push('---', '', body, '');
    return lines.join('\n');
}

function articleIdFor(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function article(
    relativePath: string,
    content: string | Buffer = markdown(),
): TestArticleInput {
    if (Buffer.isBuffer(content) || /^article_id:/m.test(content)) {
        return { relativePath, bytes: Buffer.from(content) };
    }
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const withArticleId = content.replace(
        /^---\r?\n/,
        `---${lineEnding}article_id: ${JSON.stringify(
            articleIdFor(relativePath),
        )}${lineEnding}`,
    );
    return { relativePath, bytes: Buffer.from(withArticleId, 'utf8') };
}

function manifestEntry(
    relativePath: string,
    overrides: Partial<ManifestEntry> = {},
): ManifestEntry {
    const sourceKind = relativePath.split('/')[0];
    const targetNames =
        sourceKind === 'share' ? ['qiita', 'zenn'] : [sourceKind];
    return {
        article_id: articleIdFor(relativePath),
        source: `articles/${relativePath}`,
        article_state: 'active',
        targets: Object.fromEntries(
            targetNames.map((platform) => [
                platform,
                { desired: 'published' },
            ]),
        ),
        ...overrides,
    };
}

function manifest(entries: ManifestEntry[]): TestManifest {
    return {
        schema_version: 1,
        articles: entries,
    };
}

function writeManifest(root: string, entries: ManifestEntry[]): void {
    fs.writeFileSync(
        path.join(root, 'manifest.json'),
        `${JSON.stringify(manifest(entries), null, 2)}\n`,
        'utf8',
    );
}

function writeArticle(
    root: string,
    relativePath: string,
    content: string | Buffer = markdown(),
): TestArticleInput {
    const sourceArticle = article(relativePath, content);
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, sourceArticle.bytes);
    return sourceArticle;
}

function codes(result: ValidationResult): string[] {
    return result.diagnostics.map((item) => item.code);
}

function runGit(rootDir: string, args: readonly string[]): string {
    const result = defaultGitRunner(rootDir, args);
    assert.equal(
        result.status,
        0,
        result.stderr || result.stdout || result.error?.message,
    );
    return result.stdout.trim();
}

test('source phase accepts a shared article without local_updated_at', () => {
    const result = validateArticleFiles([article('share/a.md')]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, {
        sourceFiles: 1,
        parsedArticles: 1,
        qiitaArticles: 1,
        zennArticles: 1,
    });
});

test('distribution phase requires local_updated_at for effective Qiita articles', () => {
    const result = validateArticleFiles([article('share/a.md')], {
        phase: 'distribution',
    });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('MISSING_LOCAL_UPDATED_AT'));
});

test('Qiita-only articles always require a timestamp, while Zenn-only articles do not', () => {
    const qiitaResult = validateArticleFiles([article('qiita/a.md')]);
    const zennResult = validateArticleFiles([article('zenn/a.md')]);
    assert.ok(codes(qiitaResult).includes('MISSING_LOCAL_UPDATED_AT'));
    assert.equal(zennResult.ok, true);
});

test('validates empty, NUL-containing, and invalid UTF-8 files', () => {
    const result = validateArticleFiles([
        { relativePath: 'share/empty.md', bytes: Buffer.alloc(0) },
        {
            relativePath: 'share/nul.md',
            bytes: Buffer.concat([Buffer.from(markdown()), Buffer.from([0])]),
        },
        {
            relativePath: 'share/utf8.md',
            bytes: Buffer.from([0xc3, 0x28]),
        },
    ]);
    assert.ok(codes(result).includes('EMPTY_FILE'));
    assert.ok(codes(result).includes('NUL_BYTE'));
    assert.ok(codes(result).includes('INVALID_UTF8'));
});

test('rejects malformed front matter and an empty body', () => {
    const result = validateArticleFiles([
        article('share/malformed.md', '---\ntitle: broken'),
        article('share/no-body.md', markdown({ body: '   ' })),
    ]);
    assert.ok(codes(result).includes('INVALID_FRONT_MATTER'));
    assert.ok(codes(result).includes('EMPTY_BODY'));
});

test('enforces the source metadata contract', () => {
    const invalid = [
        '---',
        'title: ""',
        'tags: []',
        'topics:',
        '  - legacy',
        'series: " padded "',
        'local_updated_at: "2026-07-23T12:00:00"',
        '---',
        '',
        '# body',
    ].join('\n');
    const result = validateArticleFiles([article('share/a.md', invalid)]);
    for (const expected of [
        'MISSING_TITLE',
        'INVALID_TAGS',
        'DEPRECATED_TOPICS',
        'INVALID_SERIES',
        'INVALID_LOCAL_UPDATED_AT',
    ]) {
        assert.ok(codes(result).includes(expected), expected);
    }
});

test('rejects a platform-specific file that overwrites the same shared path', () => {
    const result = validateArticleFiles([
        article('share/a.md', markdown({ title: '共有' })),
        article(
            'zenn/a.md',
            markdown({ title: 'Zenn版', localUpdatedAt: undefined }),
        ),
    ]);
    assert.ok(codes(result).includes('PLATFORM_OVERRIDE_CONFLICT'));
});

test('detects duplicate mutable titles within each effective platform set', () => {
    const result = validateArticleFiles([
        article('share/a.md', markdown({ title: '重複' })),
        article(
            'qiita/b.md',
            markdown({
                title: '重複',
                localUpdatedAt: '2026-07-23T12:00:00+09:00',
            }),
        ),
    ]);
    assert.ok(codes(result).includes('DUPLICATE_TITLE'));
});

test('allows the same title in Qiita-only and Zenn-only articles', () => {
    const result = validateArticleFiles([
        article(
            'qiita/a.md',
            markdown({
                title: 'プラットフォーム別',
                localUpdatedAt: '2026-07-23T12:00:00+09:00',
            }),
        ),
        article('zenn/b.md', markdown({ title: 'プラットフォーム別' })),
    ]);
    assert.equal(result.ok, true);
});

test('resolves <<<article:article_id>>> references against each effective platform set', () => {
    const missingArticleId = 'ffffffffffffffffffffffffffffffff';
    const targetArticleId = articleIdFor('share/b.md');
    const missing = validateArticleFiles([
        article(
            'share/a.md',
            markdown({
                title: 'シリーズ #0 記事A',
                series: 'シリーズ',
                body: `<<<article:${missingArticleId}>>>`,
            }),
        ),
    ]);
    assert.equal(
        missing.diagnostics.filter(
            (item) => item.code === 'UNRESOLVED_ARTICLE_REFERENCE',
        ).length,
        2,
    );

    const resolved = validateArticleFiles([
        article(
            'share/a.md',
            markdown({
                title: 'シリーズ #0 記事A',
                series: 'シリーズ',
                body: `<<<article:${targetArticleId}>>>`,
            }),
        ),
        article('share/b.md', markdown({ title: '記事B' })),
    ]);
    assert.equal(resolved.ok, true);
});

test('rejects mismatched or repeated generated-series markers', () => {
    const mismatch = validateArticleFiles([
        article('share/a.md', markdown({ body: '<!-- START_SERIES -->' })),
    ]);
    const repeated = validateArticleFiles([
        article(
            'share/a.md',
            markdown({
                body: [
                    '<!-- START_SERIES -->',
                    '<!-- END_SERIES -->',
                    '<!-- START_SERIES -->',
                    '<!-- END_SERIES -->',
                ].join('\n'),
            }),
        ),
    ]);
    assert.ok(codes(mismatch).includes('SERIES_MARKER_MISMATCH'));
    assert.ok(codes(repeated).includes('SERIES_MARKER_MULTIPLE'));
});

test('CLI parses phase options and returns zero for a valid directory', () => {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-validator-'),
    );
    writeArticle(temporaryRoot, 'share/a.md');
    writeManifest(temporaryRoot, [manifestEntry('share/a.md')]);

    const output: string[] = [];
    const io = {
        log: (message: string) => output.push(message),
        error: (message: string) => output.push(message),
    };

    try {
        assert.deepEqual(parseCliArgs([temporaryRoot, '--phase=source']), {
            articlesRoot: temporaryRoot,
            phase: 'source',
            previousManifestPath: null,
        });
        assert.deepEqual(
            parseCliArgs([
                temporaryRoot,
                '--previous-manifest=previous.json',
            ]),
            {
                articlesRoot: temporaryRoot,
                phase: 'source',
                previousManifestPath: 'previous.json',
            },
        );
        assert.equal(runCli([temporaryRoot], io), 0);
        assert.match(output.join('\n'), /validation passed/);
        assert.equal(
            runCli([path.join(temporaryRoot, 'missing')], io),
            1,
        );
        assert.equal(
            runCli([temporaryRoot, '--phase=unsupported'], io),
            2,
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('directory validation requires share and rejects nested or non-Markdown entries', () => {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-validator-layout-'),
    );

    try {
        fs.mkdirSync(path.join(temporaryRoot, 'zenn'));
        fs.writeFileSync(
            path.join(temporaryRoot, 'zenn', 'a.md'),
            markdown(),
            'utf8',
        );
        const missingShare = validateArticlesDirectory(temporaryRoot);
        assert.ok(codes(missingShare).includes('SHARE_DIRECTORY_MISSING'));

        const share = path.join(temporaryRoot, 'share');
        fs.mkdirSync(share);
        fs.mkdirSync(path.join(share, 'nested'));
        fs.writeFileSync(path.join(share, 'notes.txt'), 'not an article', 'utf8');
        fs.writeFileSync(path.join(share, 'UPPER.MD'), markdown(), 'utf8');
        const invalidLayout = validateArticlesDirectory(temporaryRoot);
        assert.ok(codes(invalidLayout).includes('SUBDIRECTORY_NOT_ALLOWED'));
        assert.equal(
            invalidLayout.diagnostics.filter(
                (item) => item.code === 'NON_MARKDOWN_FILE',
            ).length,
            2,
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('directory validation rejects symbolic links when the platform permits creating one', (t) => {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-validator-link-'),
    );
    const share = path.join(temporaryRoot, 'share');
    fs.mkdirSync(share);
    const targetArticle = article('share/target.md');
    fs.writeFileSync(path.join(share, 'target.md'), targetArticle.bytes);
    writeManifest(temporaryRoot, [manifestEntry('share/target.md')]);

    try {
        try {
            fs.symlinkSync(
                path.join(share, 'target.md'),
                path.join(share, 'linked.md'),
                'file',
            );
        } catch (error) {
            const errorCode = error instanceof Error
                ? (error as NodeJS.ErrnoException).code
                : undefined;
            if (errorCode && ['EPERM', 'EACCES', 'ENOTSUP'].includes(errorCode)) {
                t.skip(`symlink creation is unavailable: ${errorCode}`);
                return;
            }
            throw error;
        }

        const result = validateArticlesDirectory(temporaryRoot);
        assert.ok(codes(result).includes('SYMLINK_NOT_ALLOWED'));
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('rejects BOM and disallowed C0 bytes and reports NUL count and first offset', () => {
    const nulResult = validateArticleFiles([
        {
            relativePath: 'share/nul.md',
            bytes: Buffer.from([0x41, 0x00, 0x42, 0x00]),
        },
    ]);
    const nulDiagnostic = nulResult.diagnostics.find(
        (item) => item.code === 'NUL_BYTE',
    );
    assert.ok(nulDiagnostic);
    assert.match(nulDiagnostic.message, /2/);
    assert.match(nulDiagnostic.message, /offset: 1/);

    const bomResult = validateArticleFiles([
        {
            relativePath: 'share/bom.md',
            bytes: Buffer.concat([
                Buffer.from([0xef, 0xbb, 0xbf]),
                Buffer.from(markdown()),
            ]),
        },
    ]);
    assert.ok(codes(bomResult).includes('UTF8_BOM'));

    const controlResult = validateArticleFiles([
        {
            relativePath: 'share/control.md',
            bytes: Buffer.concat([Buffer.from(markdown()), Buffer.from([0x01])]),
        },
    ]);
    assert.ok(codes(controlResult).includes('C0_CONTROL_BYTE'));
});

test('requires trim-safe NFC metadata and validates optional Zenn field types', () => {
    const decomposed = 'Cafe\u0301';
    const result = validateArticleFiles([
        article(
            'share/a.md',
            markdown({
                title: decomposed,
                tags: [decomposed],
                series: decomposed,
                extra: ['emoji: 123', 'type: news', 'published: "true"'].join(
                    '\n',
                ),
            }),
        ),
    ]);

    for (const expected of [
        'INVALID_TITLE',
        'INVALID_TAGS',
        'INVALID_SERIES',
        'INVALID_EMOJI',
        'INVALID_TYPE',
        'INVALID_PUBLISHED',
    ]) {
        assert.ok(codes(result).includes(expected), expected);
    }
});

test('enforces numbered series format, detects mixing, duplicate numbers, and gaps', () => {
    const fullyUnnumbered = validateArticleFiles([
        article(
            'share/intro.md',
            markdown({ title: 'Guide introduction', series: 'Guide' }),
        ),
        article(
            'share/reference.md',
            markdown({ title: 'Guide reference', series: 'Guide' }),
        ),
    ]);
    assert.equal(fullyUnnumbered.ok, true);

    const mixed = validateArticleFiles([
        article(
            'share/0.md',
            markdown({ title: 'Guide #0 Start', series: 'Guide' }),
        ),
        article(
            'share/1.md',
            markdown({ title: 'Guide without number', series: 'Guide' }),
        ),
    ]);
    assert.ok(codes(mixed).includes('SERIES_TITLE_FORMAT'));
    assert.ok(codes(mixed).includes('MIXED_SERIES_NUMBERING'));

    const duplicateAndGap = validateArticleFiles([
        article(
            'share/0a.md',
            markdown({ title: 'Guide #0 Start', series: 'Guide' }),
        ),
        article(
            'share/0b.md',
            markdown({ title: 'Guide #0 Alternate', series: 'Guide' }),
        ),
        article(
            'share/2.md',
            markdown({ title: 'Guide #2 End', series: 'Guide' }),
        ),
    ]);
    assert.ok(codes(duplicateAndGap).includes('DUPLICATE_SERIES_NUMBER'));
    assert.ok(codes(duplicateAndGap).includes('SERIES_NUMBER_GAP'));
});

test('title references require series metadata and malformed markers are rejected', () => {
    const targetArticleId = articleIdFor('share/b.md');
    const noSeries = validateArticleFiles([
        article(
            'share/a.md',
            markdown({
                title: 'A',
                body: `<<<article:${targetArticleId}>>>`,
            }),
        ),
        article('share/b.md', markdown({ title: 'B' })),
    ]);
    assert.ok(codes(noSeries).includes('REFERENCE_REQUIRES_SERIES'));

    const malformed = validateArticleFiles([
        article('share/open.md', markdown({ body: '<<<not closed' })),
        article('share/close.md', markdown({ body: 'orphan >>>' })),
        article('share/shape.md', markdown({ body: '<<<<bad>>>>' })),
    ]);
    assert.equal(
        malformed.diagnostics.filter(
            (item) => item.code === 'MALFORMED_ARTICLE_REFERENCE',
        ).length,
        3,
    );
});

test('rejects legacy title references and malformed article IDs', () => {
    const result = validateArticleFiles([
        article(
            'share/a.md',
            markdown({
                title: 'A',
                series: 'Series',
                body: [
                    '<<<旧タイトル>>>',
                    '<<<article:not-a-32hex-id>>>',
                ].join('\n'),
            }),
        ),
    ]);

    assert.ok(codes(result).includes('LEGACY_TITLE_REFERENCE'));
    assert.ok(codes(result).includes('INVALID_ARTICLE_REFERENCE'));
});

test('filename collision keys are NFC-normalized and case-insensitive', () => {
    const result = validateArticleFiles([
        article('share/Caf\u00e9.md', markdown({ title: 'Composed' })),
        article('share/CAFE\u0301.MD', markdown({ title: 'Decomposed' })),
    ]);
    assert.ok(codes(result).includes('FILENAME_COLLISION'));
});

test('validates article_id uniqueness and manifest/front matter consistency', () => {
    const files = [
        article('share/a.md', markdown({ title: 'A' })),
        article('share/b.md', markdown({ title: 'B' })),
    ];
    const validManifest = manifest([
        manifestEntry('share/a.md'),
        manifestEntry('share/b.md'),
    ]);

    const result = validateArticleFiles(files, {
        manifest: validManifest,
    });
    assert.equal(result.ok, true);

    const duplicateId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const duplicate = validateArticleFiles([
        article(
            'share/a.md',
            markdown({ articleId: duplicateId, title: 'A' }),
        ),
        article(
            'share/b.md',
            markdown({ articleId: duplicateId, title: 'B' }),
        ),
    ]);
    assert.ok(codes(duplicate).includes('DUPLICATE_ARTICLE_ID'));

    const invalid = validateArticleFiles([
        article(
            'share/invalid.md',
            markdown({ articleId: 'NOT-A-VALID-ID' }),
        ),
    ]);
    assert.ok(codes(invalid).includes('INVALID_ARTICLE_ID'));
});

test('fails when an active manifest source is missing or its ID differs', () => {
    const files = [
        article('share/a.md', markdown({ title: 'A' })),
        article('share/unmanifested.md', markdown({ title: 'Unmanifested' })),
    ];
    const result = validateArticleFiles(files, {
        manifest: manifest([
            manifestEntry('share/a.md', {
                article_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            }),
            manifestEntry('share/missing.md'),
        ]),
    });

    assert.ok(codes(result).includes('ARTICLE_ID_MISMATCH'));
    assert.ok(codes(result).includes('ACTIVE_SOURCE_MISSING'));
    assert.ok(codes(result).includes('UNMANIFESTED_ARTICLE'));
});

test('validates reserved lifecycle enums but refuses unsupported withdrawal publishing', () => {
    const retiring = manifestEntry('share/a.md', {
        article_state: 'retiring',
        targets: {
            qiita: { desired: 'withdrawn' },
            zenn: { desired: 'withdrawn' },
        },
    });
    const result = validateArticleFiles(
        [article('share/a.md', markdown({ title: 'A' }))],
        { manifest: manifest([retiring]) },
    );

    assert.ok(codes(result).includes('UNSUPPORTED_ARTICLE_STATE'));
    assert.equal(
        result.diagnostics.filter(
            (item) => item.code === 'UNSUPPORTED_TARGET_DESIRED',
        ).length,
        2,
    );

    const invalid = validateArticleFiles(
        [article('share/a.md', markdown({ title: 'A' }))],
        {
            manifest: manifest([
                manifestEntry('share/a.md', {
                    article_state: 'deleted',
                    targets: {
                        qiita: { desired: 'hidden' },
                        zenn: { desired: 'published' },
                    },
                }),
            ]),
        },
    );
    assert.ok(codes(invalid).includes('INVALID_ARTICLE_STATE'));
    assert.ok(codes(invalid).includes('INVALID_MANIFEST_TARGET'));
});

test('directory validation requires a parseable articles/manifest.json', () => {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-validator-manifest-'),
    );

    try {
        writeArticle(temporaryRoot, 'share/a.md');
        const missing = validateArticlesDirectory(temporaryRoot);
        assert.ok(codes(missing).includes('MANIFEST_MISSING'));

        fs.writeFileSync(
            path.join(temporaryRoot, 'manifest.json'),
            '{ invalid json',
            'utf8',
        );
        const invalid = validateArticlesDirectory(temporaryRoot);
        assert.ok(codes(invalid).includes('INVALID_MANIFEST_JSON'));
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('manifest history rejects omitted IDs and removed targets', () => {
    const previous = manifest([
        manifestEntry('share/a.md'),
        manifestEntry('share/b.md'),
    ]);
    const currentEntry = manifestEntry('share/a.md', {
        targets: {
            qiita: { desired: 'published' },
        },
    });
    const result = validateArticleFiles(
        [article('share/a.md', markdown({ title: 'A' }))],
        {
            manifest: manifest([currentEntry]),
            previousManifest: previous,
        },
    );

    assert.ok(codes(result).includes('MANIFEST_ARTICLE_REMOVED'));
    assert.ok(codes(result).includes('MANIFEST_TARGET_REMOVED'));
});

test('manifest history rejects onboarding an article without a cross-platform creation protocol', () => {
    const previousEntry = manifestEntry('share/a.md');
    const addedEntry = manifestEntry('share/b.md');
    const result = validateArticleFiles(
        [
            article('share/a.md', markdown({ title: 'A' })),
            article('share/b.md', markdown({ title: 'B' })),
        ],
        {
            manifest: manifest([previousEntry, addedEntry]),
            previousManifest: manifest([previousEntry]),
        },
    );

    assert.ok(
        codes(result).includes('UNSUPPORTED_MANIFEST_ARTICLE_ADDITION'),
    );
});

test('manifest history allows an ID-preserving source rename but rejects source rebinding', () => {
    const originalId = articleIdFor('share/a.md');
    const replacementId = articleIdFor('share/replacement.md');
    const previous = manifest([manifestEntry('share/a.md')]);

    const renamed = validateArticleFiles(
        [
            article(
                'share/renamed.md',
                markdown({ articleId: originalId, title: 'Renamed' }),
            ),
        ],
        {
            manifest: manifest([
                manifestEntry('share/renamed.md', {
                    article_id: originalId,
                }),
            ]),
            previousManifest: previous,
        },
    );
    assert.equal(renamed.ok, true);

    const rebound = validateArticleFiles(
        [
            article(
                'share/renamed.md',
                markdown({ articleId: originalId, title: 'Renamed' }),
            ),
            article(
                'share/a.md',
                markdown({ articleId: replacementId, title: 'Replacement' }),
            ),
        ],
        {
            manifest: manifest([
                manifestEntry('share/renamed.md', {
                    article_id: originalId,
                }),
                manifestEntry('share/a.md', {
                    article_id: replacementId,
                }),
            ]),
            previousManifest: previous,
        },
    );
    assert.ok(codes(rebound).includes('MANIFEST_SOURCE_REBOUND'));
});

test('manifest resolver recovers the latest reachable manifest after a deletion commit', () => {
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'blog-manifest-git-'),
    );
    try {
        runGit(temporaryRoot, ['init']);
        runGit(temporaryRoot, ['config', 'user.name', 'Test User']);
        runGit(temporaryRoot, ['config', 'user.email', 'test@example.com']);
        fs.writeFileSync(
            path.join(temporaryRoot, 'README.md'),
            'history fixture\n',
            'utf8',
        );
        runGit(temporaryRoot, ['add', '--', '.']);
        runGit(temporaryRoot, ['commit', '-m', 'initial commit']);

        const neverIntroduced = loadPreviousManifestFromGit({
            rootDir: temporaryRoot,
            baselineRef: 'HEAD',
        });
        assert.equal(neverIntroduced.initialIntroduction, true);

        const manifestDirectory = path.join(temporaryRoot, 'articles');
        const manifestPath = path.join(manifestDirectory, 'manifest.json');
        const originalManifest = manifest([manifestEntry('share/a.md')]);
        fs.mkdirSync(manifestDirectory);
        fs.writeFileSync(
            manifestPath,
            `${JSON.stringify(originalManifest, null, 2)}\n`,
            'utf8',
        );
        runGit(temporaryRoot, ['add', '--', 'articles/manifest.json']);
        runGit(temporaryRoot, ['commit', '-m', 'introduce manifest']);
        const introductionCommit = runGit(
            temporaryRoot,
            ['rev-parse', 'HEAD'],
        );

        fs.rmSync(manifestPath);
        runGit(temporaryRoot, ['add', '-u', '--', 'articles/manifest.json']);
        runGit(temporaryRoot, ['commit', '-m', 'delete manifest']);

        const recovered = loadPreviousManifestFromGit({
            rootDir: temporaryRoot,
            baselineRef: 'HEAD',
        });
        assert.equal(recovered.initialIntroduction, false);
        assert.equal(recovered.recoveredFromHistory, true);
        assert.equal(recovered.sourceRef, introductionCommit);
        assert.ok(recovered.content);
        assert.deepEqual(JSON.parse(recovered.content), originalManifest);

        const reboundId = articleIdFor('replacement-id');
        const rebound = validateArticleFiles(
            [
                article(
                    'share/a.md',
                    markdown({
                        articleId: reboundId,
                        title: 'Rebound',
                    }),
                ),
            ],
            {
                manifest: manifest([
                    manifestEntry('share/a.md', {
                        article_id: reboundId,
                    }),
                ]),
                previousManifest: JSON.parse(recovered.content),
            },
        );
        assert.ok(codes(rebound).includes('MANIFEST_ARTICLE_REMOVED'));
        assert.ok(
            codes(rebound).includes(
                'UNSUPPORTED_MANIFEST_ARTICLE_ADDITION',
            ),
        );

        assert.throws(
            () =>
                loadPreviousManifestFromGit({
                    rootDir: temporaryRoot,
                    baselineRef: '0'.repeat(40),
                }),
            /zero baseline is only allowed for a root commit/,
        );
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('distribution workflow validates before PR-based child synchronization', () => {
    const workflow = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            '.github',
            'workflows',
            'distribute.yml',
        ),
        'utf8',
    );
    const resolveIndex = workflow.indexOf('resolve_manifest_history.ts');
    const validationIndex = workflow.indexOf(
        'Validate Qiita and Zenn source sets before writes',
    );
    const uploadIndex = workflow.indexOf(
        'Upload prepared distribution snapshot',
    );
    const restoreEmptyDirectoriesIndex = workflow.indexOf(
        'Restore required empty snapshot directories',
    );
    const prepareIndex = workflow.indexOf('  prepare_targets:');
    const publishJobIndex = workflow.indexOf('  publish_targets:');
    const publishIndex = workflow.indexOf(
        'Publish checked automation pull request',
    );

    assert.ok(resolveIndex >= 0);
    assert.ok(resolveIndex < validationIndex);
    assert.ok(validationIndex < uploadIndex);
    assert.ok(uploadIndex < prepareIndex);
    assert.ok(prepareIndex < restoreEmptyDirectoriesIndex);
    assert.ok(restoreEmptyDirectoriesIndex < publishJobIndex);
    assert.ok(prepareIndex < publishJobIndex);
    assert.ok(publishJobIndex < publishIndex);
    assert.match(workflow, /PREVIOUS_MANIFEST_PATH/);
    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(
        workflow,
        /github\.event\.pull_request\.base\.sha \|\| github\.event_name == 'push' && github\.event\.before \|\| format\('\{0\}\^', github\.sha\)/,
    );
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
    assert.doesNotMatch(workflow, /pull_request_target:/);
    assert.match(workflow, /^permissions:\r?\n\s+contents: read$/m);
    assert.match(workflow, /^  distribute:\r?$/m);
    assert.match(workflow, /^  prepare_targets:\r?$/m);
    assert.match(workflow, /^  publish_targets:\r?$/m);
    assert.match(workflow, /^\s+needs: distribute$/m);
    assert.match(workflow, /^\s+fail-fast: false$/m);
    assert.match(workflow, /target: qiita[\s\S]*repository: SolitudeRA\/qiita-repo/);
    assert.match(workflow, /target: zenn[\s\S]*repository: SolitudeRA\/zenn-repo/);
    assert.match(
        workflow,
        /github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/,
    );
    assert.match(
        workflow,
        /!cancelled\(\)[\s\S]*needs\.distribute\.result == 'success'/,
    );
    assert.doesNotMatch(workflow, /always\(\)/);
    assert.match(workflow, /npm run distribute:target -- prepare/);
    assert.match(workflow, /mkdir -p prepared-articles\/share/);
    assert.match(workflow, /npm run distribute:target -- export/);
    assert.match(workflow, /npm run distribute:target -- apply/);
    assert.match(workflow, /npm run distribute:target -- publish/);
    assert.match(workflow, /npm run build:articles -- --base-ref=HEAD/);
    assert.equal(
        (
            workflow.match(
                /name: prepared-articles-\$\{\{ github\.run_id \}\}/g,
            ) || []
        ).length,
        2,
    );
    assert.match(workflow, /^\s+overwrite: true$/m);
    assert.doesNotMatch(workflow, /prepared-articles-.*run_attempt/);
    assert.equal(
        (
            workflow.match(
                /prepared-target-\$\{\{ matrix\.target \}\}-\$\{\{ github\.run_id \}\}/g,
            ) || []
        ).length,
        2,
    );
    const prepareBlock = workflow.slice(prepareIndex, publishJobIndex);
    const publishBlock = workflow.slice(publishJobIndex);
    assert.match(prepareBlock, /npm ci/);
    assert.match(prepareBlock, /npx --no-install zenn list:articles/);
    assert.doesNotMatch(prepareBlock, /secrets\.BLOG_PROJECT_TOKEN/);
    assert.doesNotMatch(publishBlock, /npm ci/);
    assert.doesNotMatch(publishBlock, /npx --no-install zenn/);
    assert.ok(
        publishBlock.indexOf('Apply prepared target patch')
        < publishBlock.indexOf('secrets.BLOG_PROJECT_TOKEN'),
    );
    assert.doesNotMatch(workflow, /\bgit push\b/);
    assert.equal(
        (workflow.match(/secrets\.BLOG_PROJECT_TOKEN/g) || []).length,
        1,
    );
});
