export type SourceKind = 'share' | 'qiita' | 'zenn';
export type Platform = 'qiita' | 'zenn';
export type ValidationPhase = 'source' | 'distribution';
export type UnknownRecord = Record<string, unknown>;

export interface Diagnostic {
    code: string;
    file: string;
    message: string;
}

export interface ArticleReference {
    articleId: string;
    index: number;
}

export interface ArticleInput {
    relativePath?: string;
    bytes?: string | Uint8Array;
}

export interface ParsedArticle {
    relativePath: string;
    source: SourceKind;
    sourceRelativePath: string;
    articleId: string | null;
    title: string | null;
    series: string | null;
    localUpdatedAt: unknown;
    references: ArticleReference[];
}

export interface ParseArticleResult {
    article: ParsedArticle | null;
    diagnostics: Diagnostic[];
}

export interface ValidationCounts {
    sourceFiles: number;
    parsedArticles: number;
    qiitaArticles: number;
    zennArticles: number;
}

export interface ValidationResult {
    ok: boolean;
    phase: string;
    diagnostics: Diagnostic[];
    counts: ValidationCounts;
}

export interface ValidateArticleFilesOptions {
    phase?: string;
    manifest?: unknown | null;
    manifestFile?: string;
    previousManifest?: unknown;
    previousManifestFile?: string;
    requireManifest?: boolean;
}

export interface ValidateArticlesDirectoryOptions
    extends ValidateArticleFilesOptions {
    previousManifestPath?: string | null;
}

export interface ValidationIo {
    log(message: string): unknown;
    error(message: string): unknown;
}
