'use strict';

import type {
    Diagnostic,
} from './types.ts';

function createDiagnostic(
    code: string,
    file: string,
    message: string,
): Diagnostic {
    return { code, file, message };
}

export interface ArticleValidationDiagnosticsExports {
    createDiagnostic: typeof createDiagnostic;
}

module.exports = {
    createDiagnostic,
};
