import type { Rive, RiveParameters } from '@rive-app/canvas';
import wasmUrl from '@rive-app/canvas/rive.wasm?url';
import characterImageUrl from './assets/character.png?url';
import characterRiveUrl from './assets/character.riv?url';
import { serializePilotMascotRuntime, type PilotMascotRuntime } from './mascotRuntime';

export type { PilotMascotActivity, PilotMascotRuntime, PilotMascotRuntimeController } from './mascotRuntime';
export const MASCOT_IMAGE_URL = characterImageUrl;
export const MASCOT_RIVE_URL = characterRiveUrl;
const IDLE_ANIMATION = 'Subtle breath and peripheral hair study';

interface Dependencies {
  load: () => Promise<{ create: (parameters: RiveParameters) => Rive }>;
  reducedMotion: () => boolean;
}

/** The image is also the loading/error surface: graphics failure must not remove
 * the character or its parent's chat/drag controls. No remote asset fallback. */
export function createRivePilotMascotRuntime(dependencies: Dependencies): PilotMascotRuntime {
  return serializePilotMascotRuntime({
    async mount(canvas, signal, animationLevel = 'full') {
      if (signal?.aborted) throw new DOMException('Mascot mount aborted', 'AbortError');
      const image = document.createElement('img');
      image.src = MASCOT_IMAGE_URL;
      image.alt = '';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');
      image.dataset.mascotFallback = '';
      Object.assign(image.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' });
      canvas.after(image);
      const previousVisibility = canvas.style.visibility;
      canvas.style.visibility = 'hidden';
      canvas.dataset.mascotRenderer = 'static';
      let player: Rive | undefined;
      let disposed = false;
      let failed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let frame: number | undefined;
      let healthTimer: ReturnType<typeof setInterval> | undefined;
      let observer: ResizeObserver | undefined;
      const stopPlayer = () => {
        const current = player;
        player = undefined;
        try { current?.cleanup(); } catch { /* Static fallback remains usable. */ }
      };
      const fallback = () => {
        if (disposed) return;
        failed = true;
        clearTimeout(timer);
        clearInterval(healthTimer);
        if (frame !== undefined) cancelAnimationFrame(frame);
        observer?.disconnect();
        canvas.style.visibility = 'hidden';
        image.hidden = false;
        canvas.dataset.mascotRenderer = 'static';
        stopPlayer();
      };
      const resize = () => {
        if (disposed || failed) return;
        try { player?.resizeDrawingSurfaceToCanvas(Math.min(window.devicePixelRatio || 1, 2)); }
        catch { fallback(); }
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        clearInterval(healthTimer);
        if (frame !== undefined) cancelAnimationFrame(frame);
        observer?.disconnect();
        signal?.removeEventListener('abort', dispose);
        canvas.removeEventListener('contextlost', fallback);
        canvas.removeEventListener('webglcontextlost', fallback);
        window.removeEventListener('resize', resize);
        stopPlayer();
        image.remove();
        canvas.style.visibility = previousVisibility;
        delete canvas.dataset.mascotRenderer;
      };
      signal?.addEventListener('abort', dispose, { once: true });
      canvas.addEventListener('contextlost', fallback);
      canvas.addEventListener('webglcontextlost', fallback);
      // Static means no WASM, graphics context, ticker, or blink at all.
      if (animationLevel !== 'off' && !dependencies.reducedMotion()) {
        timer = setTimeout(fallback, 15_000);
        void dependencies.load().then(({ create }) => {
          if (disposed || failed) return;
          player = create({
            canvas, src: MASCOT_RIVE_URL, autoplay: true,
            enableRiveAssetCDN: false,
            animations: IDLE_ANIMATION,
            onLoad: () => {
              // Loaded does not prove image meshes rendered. Check real alpha
              // after drawing, since unsupported graphics can fail silently.
              let attempts = 0;
              const verifyPixels = () => {
                if (disposed || failed) return;
                try {
                  const context = canvas.getContext('2d');
                  const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
                  let visible = 0;
                  for (let i = 3; pixels && i < pixels.length; i += 4) if (pixels[i] > 32) visible++;
                  if (visible > canvas.width * canvas.height * .01) {
                    clearTimeout(timer);
                    canvas.style.visibility = previousVisibility;
                    image.hidden = true;
                    canvas.dataset.mascotRenderer = 'rive';
                    let emptyChecks = 0;
                    healthTimer = setInterval(() => {
                      if (disposed || failed || document.visibilityState === 'hidden' || !canvas.clientWidth || !canvas.clientHeight) return;
                      try {
                        const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
                        let visible = 0;
                        for (let i = 3; data && i < data.length; i += 4) if (data[i] > 32) visible++;
                        emptyChecks = visible > canvas.width * canvas.height * .01 ? 0 : emptyChecks + 1;
                        if (emptyChecks >= 2) fallback();
                      } catch { fallback(); }
                    }, 2_000);
                  } else if (++attempts < 10) frame = requestAnimationFrame(verifyPixels);
                  else fallback();
                } catch { fallback(); }
              };
              frame = requestAnimationFrame(verifyPixels);
            },
            onLoadError: fallback,
          });
          if (failed || disposed) { stopPlayer(); return; }
          observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
          observer?.observe(canvas);
          window.addEventListener('resize', resize);
          resize();
        }).catch(fallback);
      }
      return {
        // The approved asset has one restrained idle, no invented expressions.
        setActivity: () => undefined,
        setZoom: resize,
        dispose,
      };
    },
  });
}

export const rivePilotMascotRuntime = createRivePilotMascotRuntime({
  async load() {
    const probe = document.createElement('canvas');
    const graphics = probe.getContext('webgl2');
    if (!graphics) throw new Error('Rive image mesh graphics unavailable');
    graphics.getExtension('WEBGL_lose_context')?.loseContext();
    const { Rive, RuntimeLoader, Layout, Fit, Alignment } = await import('@rive-app/canvas');
    RuntimeLoader.setWasmUrl(wasmUrl);
    RuntimeLoader.setWasmFallbackUrl(null);
    return { create: (parameters) => new Rive({ ...parameters, layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }) }) };
  },
  reducedMotion: () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
});
