'use strict';

import type {
    Platform,
    SourceKind,
} from './types.ts';

const SOURCE_KINDS = new Set<SourceKind>(['share', 'qiita', 'zenn']);
const PLATFORMS: Platform[] = ['qiita', 'zenn'];
const SERIES_START = '<!-- START_SERIES -->';
const SERIES_END = '<!-- END_SERIES -->';
const ARTICLE_ID_PATTERN = /^[0-9a-f]{32}$/;
const ARTICLE_STATES = new Set<string>(['active', 'retiring', 'retired']);
const TARGET_DESIRED_STATES = new Set<string>(['published', 'withdrawn']);
const TIMESTAMP_WITH_ZONE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ArticleValidationConstantsExports {
    ARTICLE_ID_PATTERN: typeof ARTICLE_ID_PATTERN;
    ARTICLE_STATES: typeof ARTICLE_STATES;
    PLATFORMS: typeof PLATFORMS;
    SERIES_END: typeof SERIES_END;
    SERIES_START: typeof SERIES_START;
    SOURCE_KINDS: typeof SOURCE_KINDS;
    TARGET_DESIRED_STATES: typeof TARGET_DESIRED_STATES;
    TIMESTAMP_WITH_ZONE: typeof TIMESTAMP_WITH_ZONE;
}

module.exports = {
    ARTICLE_ID_PATTERN,
    ARTICLE_STATES,
    PLATFORMS,
    SERIES_END,
    SERIES_START,
    SOURCE_KINDS,
    TARGET_DESIRED_STATES,
    TIMESTAMP_WITH_ZONE,
};
