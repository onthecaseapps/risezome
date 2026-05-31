export type SidecarManifest = Record<string, { sha256: string }>;

const PRODUCTION_MANIFEST: SidecarManifest = {};

export function getSidecarManifest(override?: SidecarManifest): SidecarManifest {
  return override ?? PRODUCTION_MANIFEST;
}
