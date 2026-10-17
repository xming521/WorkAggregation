// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rive, RiveParameters } from '@rive-app/canvas';
import { createRivePilotMascotRuntime, MASCOT_IMAGE_URL } from './riveRuntime';

let host: HTMLDivElement;
let canvas: HTMLCanvasElement;
let parameters: RiveParameters;
const cleanup = vi.fn();
const resize = vi.fn();
const create = vi.fn((value: RiveParameters) => {
  parameters = value;
  return { cleanup, resizeDrawingSurfaceToCanvas: resize } as unknown as Rive;
});
const load = vi.fn(async () => ({ create }));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const ready = async () => { parameters.onLoad?.({ type: 'load' } as never); await vi.advanceTimersByTimeAsync(100); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  load.mockResolvedValue({ create });
  cleanup.mockImplementation(() => undefined);
  resize.mockImplementation(() => undefined);
  host = document.createElement('div');
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  host.append(canvas); document.body.append(host);
  vi.spyOn(canvas, 'getContext').mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray(16).fill(255) }) } as never);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => { host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('original mascot runtime', () => {
  it.each(['off', 'reduced'] as const)('uses a static image without loading WASM for %s', async (mode) => {
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => mode === 'reduced' });
    const controller = await runtime.mount(canvas, undefined, mode === 'off' ? 'off' : 'full');
    expect(load).not.toHaveBeenCalled();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(MASCOT_IMAGE_URL);
    expect(canvas.dataset.mascotRenderer).toBe('static');
    controller.dispose();
    expect(host.querySelector('img')).toBeNull();
    expect(canvas.style.visibility).toBe('');
  });
  it('keeps the image until real pixels appear and cleans up after context loss', async () => {
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => false });
    const controller = await runtime.mount(canvas); await flush();
    expect(host.querySelector('img')!.hidden).toBe(false);
    await ready();
    expect(host.querySelector('img')!.hidden).toBe(true);
    expect(canvas.dataset.mascotRenderer).toBe('rive');
    canvas.dispatchEvent(new Event('contextlost'));
    expect(host.querySelector('img')!.hidden).toBe(false);
    expect(canvas.dataset.mascotRenderer).toBe('static');
    expect(cleanup).toHaveBeenCalledTimes(1);
    controller.dispose(); controller.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not mistake onLoad with blank mesh output for rendering success', async () => {
    vi.mocked(canvas.getContext).mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray(16) }) } as never);
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => false });
    const controller = await runtime.mount(canvas); await flush(); await ready();
    await vi.advanceTimersByTimeAsync(200);
    expect(canvas.dataset.mascotRenderer).toBe('static');
    expect(host.querySelector('img')!.hidden).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it('detects offscreen mesh loss after success without a visible-canvas event', async () => {
    Object.defineProperties(canvas, { clientWidth: { value: 2 }, clientHeight: { value: 2 } });
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => false });
    const controller = await runtime.mount(canvas); await flush(); await ready();
    expect(canvas.dataset.mascotRenderer).toBe('rive');
    vi.mocked(canvas.getContext).mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray(16) }) } as never);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(canvas.dataset.mascotRenderer).toBe('rive');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(canvas.dataset.mascotRenderer).toBe('static');
    expect(host.querySelector('img')!.hidden).toBe(false);
    controller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains static fallback for module failure, timeout, and late callbacks', async () => {
    load.mockRejectedValueOnce(new Error('graphics unavailable'));
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => false });
    const first = await runtime.mount(canvas); await flush();
    expect(canvas.dataset.mascotRenderer).toBe('static'); first.dispose();
    const second = await runtime.mount(canvas); await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await ready();
    expect(canvas.dataset.mascotRenderer).toBe('static');
    expect(host.querySelector('img')!.hidden).toBe(false); second.dispose();
  });
  it('aborts pending loads without creating a late player or retaining fallback nodes', async () => {
    let finish!: (value: { create: typeof create }) => void;
    load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => false });
    const abort = new AbortController();
    const controller = await runtime.mount(canvas, abort.signal);
    abort.abort(); finish({ create }); await flush();
    expect(create).not.toHaveBeenCalled();
    expect(host.querySelector('img')).toBeNull();
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('serializes repeated mounts and releases even when renderer cleanup throws', async () => {
    const runtime = createRivePilotMascotRuntime({ load, reducedMotion: () => false });
    const first = await runtime.mount(canvas); await flush();
    const pending = runtime.mount(canvas);
    expect(host.querySelectorAll('img')).toHaveLength(1);
    cleanup.mockImplementationOnce(() => { throw new Error('lost context'); });
    first.dispose();
    const second = await pending;
    expect(host.querySelectorAll('img')).toHaveLength(1);
    second.dispose();
    expect(host.querySelector('img')).toBeNull();
  });
});
