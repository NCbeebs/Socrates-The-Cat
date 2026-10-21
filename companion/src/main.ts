import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import petManifest from "@habitat/pet-manifest";
import { createPetRenderer } from "./pet/draw-pet";
import {
  HabitatPet,
  type PetDrawState,
  type PetPointerDebug,
} from "./pet/habitat-pet";
import { petClipUrls } from "./pet/pet-clips";
import { ActivityJournal } from "./journal";
import { createPetLoopClock } from "./pet-loop-clock";
import {
  writeLog,
  writeDebug,
  reportFailure,
  reportRecovery,
} from "./runtime-log";
import type {
  GeometryMeta,
  IdeLocalPointer,
  PetManifest,
  SurfaceSeg,
} from "./pet/types";

interface SurfacesFile {
  windowLocalRect: { width: number; height: number };
  surfaces: SurfaceSeg[];
  surfaceSource?: "live" | "file" | string;
  revision?: number;
  uiaNodeCount?: number;
  scanSequence?: number;
  scanObservedAtMs?: number;
  targetHwnd?: number;
}

interface IdeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

interface HabitatPresentation {
  debug: boolean;
  debugSurfaces: boolean;
  debugHud: boolean;
  debugLog: boolean;
}

function roleColor(role: string, walkable: boolean): string {
  if (role === "wall") return "#ff7840";
  if (walkable) return "#50ff8c";
  return "#78b4ff";
}

function viewportSize(): { w: number; h: number } {
  return {
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  };
}

function ensureSurfacesLayer(svg: SVGSVGElement): SVGGElement {
  let layer = svg.querySelector<SVGGElement>("#layer-surfaces");
  if (!layer) {
    layer = document.createElementNS(SVG_NS, "g");
    layer.setAttribute("id", "layer-surfaces");
    svg.insertBefore(layer, svg.firstChild);
  }
  return layer;
}

function drawSurfaces(
  layer: SVGGElement,
  svg: SVGSVGElement,
  data: SurfacesFile,
  w: number,
  h: number,
  showSurfaces: boolean,
) {
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));

  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
  if (!showSurfaces) {
    layer.setAttribute("display", "none");
    const refW = data.windowLocalRect.width || w;
    const refH = data.windowLocalRect.height || h;
    return { sx: w / refW, sy: h / refH };
  }
  layer.setAttribute("display", "inline");

  const refW = data.windowLocalRect.width || w;
  const refH = data.windowLocalRect.height || h;
  const sx = w / refW;
  const sy = h / refH;

  for (const s of data.surfaces) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(s.a.x * sx));
    line.setAttribute("y1", String(s.a.y * sy));
    line.setAttribute("x2", String(s.b.x * sx));
    line.setAttribute("y2", String(s.b.y * sy));
    line.setAttribute("stroke", roleColor(s.role, s.walkable));
    line.setAttribute("stroke-width", s.role === "wall" ? "5" : "4");
    line.setAttribute("stroke-linecap", "round");
    if (s.role === "wall") {
      line.setAttribute("stroke-dasharray", "6 4");
    }
    layer.appendChild(line);
  }

  return { sx, sy };
}

function ensurePointerDebugLayer(svg: SVGSVGElement): SVGGElement {
  let layer = svg.querySelector<SVGGElement>("#layer-pointer-debug");
  if (!layer) {
    layer = document.createElementNS(SVG_NS, "g");
    layer.setAttribute("id", "layer-pointer-debug");
    layer.setAttribute("pointer-events", "none");
    svg.appendChild(layer);
  }
  return layer;
}

function drawPointerDebug(layer: SVGGElement, debug: PetPointerDebug | null) {
  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
  if (!debug) {
    layer.setAttribute("display", "none");
    return;
  }
  layer.setAttribute("display", "inline");
  if (debug.reach) {
    const rect = document.createElementNS(SVG_NS, "rect");
    const w = debug.reach.x1 - debug.reach.x0;
    const h = debug.reach.y1 - debug.reach.y0;
    rect.setAttribute("x", String(debug.reach.x0));
    rect.setAttribute("y", String(debug.reach.y0));
    rect.setAttribute("width", String(Math.max(1, w)));
    rect.setAttribute("height", String(Math.max(1, h)));
    rect.setAttribute("fill", "rgba(255, 200, 64, 0.12)");
    rect.setAttribute("stroke", "#ffc840");
    rect.setAttribute("stroke-width", "1.5");
    rect.setAttribute("stroke-dasharray", "4 3");
    layer.appendChild(rect);
  }
  if (debug.sample) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(debug.sample.x));
    dot.setAttribute("cy", String(debug.sample.y));
    dot.setAttribute("r", "5");
    dot.setAttribute("fill", "#ff5050");
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", "1");
    layer.appendChild(dot);
  }
  if (debug.pounceDestLocalX != null && debug.reach) {
    const dest = document.createElementNS(SVG_NS, "line");
    dest.setAttribute("x1", String(debug.pounceDestLocalX));
    dest.setAttribute("x2", String(debug.pounceDestLocalX));
    dest.setAttribute("y1", String(debug.reach.y0));
    dest.setAttribute("y2", String(debug.reach.y1));
    dest.setAttribute("stroke", "#50c8ff");
    dest.setAttribute("stroke-width", "2");
    dest.setAttribute("stroke-dasharray", "3 2");
    layer.appendChild(dest);
  }
  const lines: string[] = [];
  if (debug.rejectReason) {
    lines.push(`ptr: ${debug.rejectReason}`);
  }
  if (debug.pounceReject) {
    lines.push(`pounce: ${debug.pounceReject}`);
  }
  lines.push(`comboRearm: ${debug.comboRearm ? "yes" : "no"}`);
  lines.push(`pounceContinue: ${debug.pounceContinue ? "yes" : "no"}`);
  if (lines.length > 0) {
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", "8");
    label.setAttribute("y", "20");
    label.setAttribute("fill", "#ffc840");
    label.setAttribute("font-size", "11");
    label.setAttribute("font-family", "ui-monospace, monospace");
    label.textContent = lines.join(" | ");
    layer.appendChild(label);
  }
}

const POINTER_POLL_MS = 50;
const HUD_REFRESH_MS = 250;

async function renderLoop(svg: SVGSVGElement, hud: HTMLElement) {
  const win = getCurrentWindow();
  await win.setIgnoreCursorEvents(true);

  const presentation = await invoke<HabitatPresentation>("get_habitat_presentation");
  const showSurfaces = presentation.debugSurfaces;
  const showHud = presentation.debugHud;
  const showPointerDebug = presentation.debug;
  const verboseLog = presentation.debugLog;
  hud.hidden = !showHud;
  const renderStartedAt = performance.now();

  const manifest = petManifest as unknown as PetManifest;
  const pet = new HabitatPet(manifest, petClipUrls());
  pet.setPointerDebugEnabled(showPointerDebug);
  let drawPet: (state: PetDrawState) => void;
  try {
    const clipUrls = await pet.preload();
    drawPet = await createPetRenderer(svg, manifest.habitat, clipUrls);
  } catch (e) {
    reportFailure("frontend", "pet_assets_failed", e);
    return;
  }

  const surfacesLayer = ensureSurfacesLayer(svg);
  const pointerDebugLayer = ensurePointerDebugLayer(svg);

  let lastDrawKey = "";
  let lastHud = "";
  let lastSx = 1;
  let lastSy = 1;
  let lastSurfaces: SurfaceSeg[] = [];
  let lastSurfaceRevision = 0;
  let lastGeometryMeta: GeometryMeta = {
    observedAtMs: Date.now(),
    targetHwnd: 0,
    scanSequence: 0,
    surfaceSource: "file",
  };
  let lastPetHud = "";
  let hudLineCache = "";
  let pointerSample: IdeLocalPointer | null = null;
  let pointerPollInFlight = false;
  let lastPayload: SurfacesFile | null = null;
  let firstFrameLogged = false;
  let lastAppliedSequence = 0;
  let pendingGeometryDelivery: {
    sequence: number;
    revision: number;
    via: "invoke" | "event";
    snapshotAgeMs: number;
  } | null = null;
  let lastGeometryDeliveryLogAt = 0;

  const flushGeometryDeliveryLog = (force = false) => {
    if (!verboseLog || !pendingGeometryDelivery) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastGeometryDeliveryLogAt < 1000) {
      return;
    }
    const p = pendingGeometryDelivery;
    pendingGeometryDelivery = null;
    lastGeometryDeliveryLogAt = now;
    writeDebug(
      "frontend",
      "geometry_applied",
      `sequence=${p.sequence} revision=${p.revision} via=${p.via} snapshot_age_ms=${p.snapshotAgeMs}`,
    );
  };

  const applySurfacesPayload = (data: SurfacesFile, via: "invoke" | "event") => {
    const incomingSeq = data.scanSequence ?? 0;
    const currentSeq = lastGeometryMeta.scanSequence ?? 0;
    if (incomingSeq > 0 && currentSeq > 0 && incomingSeq < currentSeq) {
      if (verboseLog) {
        writeDebug(
          "frontend",
          "geometry_discarded",
          `reason=stale_sequence incoming=${incomingSeq} applied=${currentSeq} via=${via}`,
        );
      }
      return;
    }
    const { w, h } = viewportSize();
    if (w < 2 || h < 2) {
      return;
    }
    lastPayload = data;
    lastSurfaceRevision = data.revision ?? 0;
    lastGeometryMeta = {
      observedAtMs: data.scanObservedAtMs ?? Date.now(),
      targetHwnd: data.targetHwnd ?? 0,
      scanSequence: data.scanSequence ?? 0,
      surfaceSource: data.surfaceSource ?? "live",
    };
    lastSurfaces = data.surfaces;
    lastAppliedSequence = incomingSeq;
    if (verboseLog) {
      pendingGeometryDelivery = {
        sequence: incomingSeq,
        revision: data.revision ?? 0,
        via,
        snapshotAgeMs: Math.max(0, Date.now() - (data.scanObservedAtMs ?? Date.now())),
      };
      flushGeometryDeliveryLog();
    }

    const json = JSON.stringify(data.surfaces);
    const rev = data.revision ?? 0;
    const drawKey = `${w}x${h}|${rev}|${json}`;
    if (drawKey !== lastDrawKey) {
      lastDrawKey = drawKey;
      const mapped = drawSurfaces(
        surfacesLayer,
        svg,
        data,
        w,
        h,
        showSurfaces,
      );
      lastSx = mapped.sx;
      lastSy = mapped.sy;
    } else {
      const refW = data.windowLocalRect.width || w;
      const refH = data.windowLocalRect.height || h;
      lastSx = w / refW;
      lastSy = h / refH;
    }

    const src = data.surfaceSource ?? "?";
    const revLabel = data.revision != null ? ` r${data.revision}` : "";
    const nodes =
      data.uiaNodeCount != null ? ` uia:${data.uiaNodeCount}` : "";
    if (showHud) {
      lastHud = `surfaces: ${data.surfaces.length} [${src}${revLabel}${nodes}]`;
    }
  };

  const refreshSurfaces = async () => {
    try {
      const data = await invoke<SurfacesFile>("load_surfaces");
      applySurfacesPayload(data, "invoke");
      reportRecovery("geometry", "load_surfaces_failed");
    } catch (e) {
      // Live scans arrive asynchronously; no snapshot yet is normal when Cursor is absent.
      if (String(e).startsWith("Set HABITAT_SURFACES_PATH")) {
        if (!lastPayload) window.setTimeout(() => { void refreshSurfaces(); }, 1000);
        return;
      }
      reportFailure("geometry", "load_surfaces_failed", e);
      if (showHud) {
        lastHud = `surfaces: ${String(e)}`;
      }
    }
  };

  const refreshPointer = async () => {
    if (pointerPollInFlight) {
      return;
    }
    pointerPollInFlight = true;
    try {
      pointerSample = await invoke<IdeLocalPointer | null>(
        "get_pointer_in_ide_local",
      );
      reportRecovery("pointer", "pointer_poll_failed");
    } catch (error) {
      reportFailure("pointer", "pointer_poll_failed", error);
      pointerSample = null;
    } finally {
      pointerPollInFlight = false;
    }
  };

  const refreshHudLine = async () => {
    if (!showHud) {
      return;
    }
    const { w, h } = viewportSize();
    let hudLine = `view ${w}×${h}`;
    try {
      const bounds = await invoke<IdeBounds>("get_ide_bounds");
      hudLine += ` | IDE ${bounds.width}×${bounds.height}`;
    } catch (e) {
      hudLine += ` | IDE: ${String(e)}`;
    }
    hudLine += ` | ${lastHud}`;
    hudLine += lastPetHud;
    hudLineCache = hudLine;
  };

  await listen<SurfacesFile>("habitat-surfaces", (event) => {
    applySurfacesPayload(event.payload, "event");
    reportRecovery("geometry", "load_surfaces_failed");
  });
  void refreshSurfaces();
  void refreshPointer();

  window.addEventListener("resize", () => {
    if (lastPayload) {
      lastDrawKey = "";
      applySurfacesPayload(lastPayload, "invoke");
    }
  });

  window.setInterval(() => {
    void refreshPointer();
  }, POINTER_POLL_MS);
  window.setInterval(() => {
    void refreshHudLine();
  }, HUD_REFRESH_MS);
  if (verboseLog) {
    window.setInterval(() => {
      flushGeometryDeliveryLog(true);
    }, 1000);
  }

  const journal = new ActivityJournal(writeLog);
  writeLog({
    level: "info",
    source: "frontend",
    event: "ready",
    message: "Socrates is ready (initialization complete; awaiting first frame).",
  });

  const FRAME_MS = 1000 / 60;
  const loopClock = createPetLoopClock((dt) => {
    const state = pet.update(
      dt,
      lastSurfaces,
      lastSx,
      lastSy,
      viewportSize(),
      pointerSample,
      lastSurfaceRevision,
      lastGeometryMeta,
    );
    drawPet(state);
    if (!firstFrameLogged) {
      firstFrameLogged = true;
      if (verboseLog) {
        writeDebug(
          "frontend",
          "first_frame",
          `elapsed_ms=${Math.round(performance.now() - renderStartedAt)} last_sequence=${lastAppliedSequence}`,
        );
      }
    }
    journal.observe(state);
    if (showPointerDebug) {
      drawPointerDebug(pointerDebugLayer, state.pointerDebug);
    }
    if (showHud) {
      const sup = state.supportId ?? "—";
      const overlay = state.overlayAnimationKey
        ? `+${state.overlayAnimationKey}`
        : "";
      const ptrHint = state.pointerDebug?.rejectReason
        ? ` | ptr:${state.pointerDebug.rejectReason}`
        : "";
      lastPetHud = ` | cat: ${state.motionPhase} @${sup} ${state.activityId}/${state.animationKey}${overlay}${ptrHint}`;
    }

    if (showHud) {
      hud.textContent = hudLineCache;
    }
  });

  loopClock.seed(performance.now() - FRAME_MS);

  const tick = (ts: number) => {
    loopClock.onAnimationFrame(ts);
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  window.addEventListener("visibilitychange", () => {
    loopClock.onVisibilityChange();
  });
  // WebView2 may throttle rAF while the overlay is unfocused; advance only when visible.
  window.setInterval(() => {
    loopClock.onFallbackTimer();
  }, FRAME_MS);
}

window.addEventListener("DOMContentLoaded", () => {
  const svg = document.querySelector<SVGSVGElement>("#overlay-svg");
  const hud = document.querySelector<HTMLElement>("#hud");
  if (!svg || !hud) {
    reportFailure("frontend", "initialization_failed", "Missing overlay SVG or HUD element");
    return;
  }
  void renderLoop(svg, hud).catch((error) => reportFailure("frontend", "initialization_failed", error));
});
