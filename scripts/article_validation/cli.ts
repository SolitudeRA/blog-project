'use strict';

import type {
    ValidationIo,
    ValidationPhase,
    ValidationResult,
} from './types.ts';
import type {
    ArticleValidationDirectoryExports,
} from './directory.ts';

const path: typeof import('node:path') = require('node:path');
const {
    validateArticlesDirectory,
} = require('./directory.ts') as ArticleValidationDirectoryExports;

function formatResult(result: ValidationResult): string {
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

export interface ParsedCliArgs {
    articlesRoot: string;
    phase: ValidationPhase;
    previousManifestPath: string | null;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
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

    return {
        articlesRoot,
        phase: phase as ValidationPhase,
        previousManifestPath,
    };
}

function runCli(
    argv: string[] = process.argv.slice(2),
    io: ValidationIo = console,
): number {
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
        io.error(
            `Article validation could not run: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return 2;
    }
}

export interface ArticleValidationCliExports {
    formatResult: typeof formatResult;
    parseCliArgs: typeof parseCliArgs;
    runCli: typeof runCli;
}

module.exports = {
    formatResult,
    parseCliArgs,
    runCli,
};
