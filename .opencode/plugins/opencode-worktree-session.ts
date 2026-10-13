// Local discovery entry: opencode v2 loads `.opencode/plugins/*.ts`, while the
// v1 implementation lives in v1/ and `v2/server.ts` holds the v2 API code.
// Re-exporting the dual-contract root entry keeps local dogfooding on the same
// file npm consumers get via the package's "./server" export.
export { default } from '../../server.ts';
