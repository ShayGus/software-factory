import { z } from 'zod';
import { RefSchema } from './primitives.js';

/** Exact persisted artifact identities; selection and provenance are not inferred. */
export const BundleRefsSchema = z.strictObject({ design: RefSchema, plan: RefSchema, tasks: z.array(RefSchema).min(1) });
export type BundleRefs = z.infer<typeof BundleRefsSchema>;
export function bundleUrl(projectId: string, featureId: string, bundle: BundleRefs): string {
  return `/projects/${encodeURIComponent(projectId)}/features/${encodeURIComponent(featureId)}?bundle=${encodeURIComponent(JSON.stringify(bundle))}`;
}
