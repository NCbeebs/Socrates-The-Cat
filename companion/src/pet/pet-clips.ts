/**
 * Maps `pet.json` animation `clip` filenames to bundled asset URLs for `HabitatPet` / `draw-pet`.
 */

import petManifest from "@habitat/pet-manifest";

/** Clip PNGs referenced by `pet.json` only (repo ships no extra sheets). */
const modules = import.meta.glob(
  "../../../assets/pets/default-cat/*.png",
  { query: "?url", import: "default", eager: true },
) as Record<string, string>;

function manifestClipNames(): Set<string> {
  const names = new Set<string>();
  const animations = petManifest.habitat?.animations;
  if (!animations || typeof animations !== "object") return names;
  for (const def of Object.values(animations)) {
    if (def && typeof def === "object" && "clip" in def && typeof def.clip === "string") {
      names.add(def.clip);
    }
  }
  const defaultClip = petManifest.habitat?.defaultClip;
  if (typeof defaultClip === "string") {
    names.add(defaultClip);
  }
  return names;
}

/** Basename → Vite `?url` (e.g. `socs-idle.png`). */
export function petClipUrls(): Record<string, string> {
  const allowed = manifestClipNames();
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(modules)) {
    const base = path.split(/[/\\]/).pop();
    if (base && allowed.has(base)) {
      out[base] = url;
    }
  }
  return out;
}
