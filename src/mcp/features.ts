import { mathForShape } from '../render/math.js';
import { checkLatex, registerExtraTools } from './extraTools.js';
import type { McpContext } from './server.js';

/** Everything the production MCP endpoint enables on top of the core tools. */
export const fullMcpFeatures: Partial<McpContext> = {
    math: mathForShape,
    validateLatex: checkLatex,
    extend: registerExtraTools,
};
