import type { PetDrawState } from "./habitat-pet";
import type { HabitatBlock } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Snap overlay coords to reduce SVG sub-pixel shimmer between frames. */
function snapPx(n: number): number {
  return Math.round(n);
}

/** Prepare retained SVG images so frame updates never replace a loaded sprite. */
export async function createPetRenderer(
  svg: SVGSVGElement,
  habitat: HabitatBlock,
  clipUrls: readonly string[],
): Promise<(state: PetDrawState) => void> {
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("id", "layer-pet");
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.setAttribute("id", "pet-defs");
  const clipId = "pet-frame-clip";
  const clip = document.createElementNS(SVG_NS, "clipPath");
  clip.setAttribute("id", clipId);
  clip.setAttribute("clipPathUnits", "userSpaceOnUse");
  const rect = document.createElementNS(SVG_NS, "rect");
  clip.appendChild(rect);
  defs.appendChild(clip);
  svg.insertBefore(defs, svg.firstChild);
  svg.appendChild(layer);

  const images = new Map<string, SVGImageElement>();
  try {
    await Promise.all([...new Set(clipUrls)].map((url) => {
      const img = document.createElementNS(SVG_NS, "image");
      img.setAttribute("visibility", "hidden");
      img.setAttribute("clip-path", `url(#${clipId})`);
      img.setAttribute("pointer-events", "none");
      img.style.imageRendering = "pixelated";
      images.set(url, img);
      return new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`pet SVG clip load failed: ${url}`));
        img.setAttribute("href", url);
        layer.appendChild(img);
      });
    }));
  } catch (e) {
    layer.remove();
    defs.remove();
    throw e;
  } finally {
    for (const img of images.values()) {
      img.onload = null;
      img.onerror = null;
    }
  }

  let activeImage: SVGImageElement | null = null;
  return (state) => {
    const img = images.get(state.clipUrl);
    if (!img) {
      throw new Error(`pet SVG clip not prepared: ${state.clipUrl}`);
    }

    const [fw, fh] = habitat.grid.frameSize;
    const [cw, ch] = state.clipCellSize;
    const [clipW, clipH] = state.clipSize;
    const scale = state.scale;
    // Keep pivot-aligned positioning and uniform atlas scaling in the same coordinates as the clip.
    const cellScale = scale * (fw / cw);
    const clipWDisplay = fw * scale;
    const clipHDisplay = fh * scale;
    const drawX = snapPx(state.x);
    const drawY = snapPx(state.y);
    // Inset ~½px so scaled atlas sampling does not bleed the next grid column.
    rect.setAttribute("x", String(drawX));
    rect.setAttribute("y", String(drawY));
    rect.setAttribute("width", String(Math.max(1, Math.floor(clipWDisplay) - 1)));
    rect.setAttribute("height", String(Math.max(1, Math.floor(clipHDisplay) - 1)));

    if (state.flipX) {
      const cx = drawX + clipWDisplay / 2;
      layer.setAttribute("transform", `scale(-1,1) translate(${-2 * cx},0)`);
    } else {
      layer.removeAttribute("transform");
    }

    img.setAttribute("x", String(drawX - state.frameCol * cw * cellScale));
    img.setAttribute("y", String(drawY - state.frameRow * ch * cellScale));
    img.setAttribute("width", String(clipW * cellScale));
    img.setAttribute("height", String(clipH * cellScale));

    if (img !== activeImage) {
      activeImage?.setAttribute("visibility", "hidden");
      img.setAttribute("visibility", "visible");
      activeImage = img;
    }
  };
}
