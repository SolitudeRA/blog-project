'use strict';

function normalizePath(filePath: string): string {
    return filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function collisionKey(filePath: string): string {
    return normalizePath(filePath).normalize('NFC').toLowerCase();
}

export interface ArticleValidationNormalizationExports {
    collisionKey: typeof collisionKey;
    normalizePath: typeof normalizePath;
}

module.exports = {
    collisionKey,
    normalizePath,
};
