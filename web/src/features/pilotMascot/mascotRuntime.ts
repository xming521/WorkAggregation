import { type PilotMascotAnimationLevel } from './pilotMascotPreference';

export type PilotMascotActivity =
  | 'idle'
  | 'thinking'
  | 'preparing_voice'
  | 'speaking'
  | 'waiting_for_speech'
  | 'listening'
  | 'speech_paused'
  | 'transcribing'
  | 'reviewing_voice'
  | 'waiting_confirmation'
  | 'success'
  | 'error';

export interface PilotMascotRuntimeController {
  setActivity(activity: PilotMascotActivity): void;
  setZoom(zoom: number): void;
  dispose(): void;
}

export interface PilotMascotRuntime {
  mount(
    canvas: HTMLCanvasElement,
    signal?: AbortSignal,
    animationLevel?: PilotMascotAnimationLevel,
  ): Promise<PilotMascotRuntimeController>;
}

export function serializePilotMascotRuntime(runtime: PilotMascotRuntime): PilotMascotRuntime {
  const canvasQueues = new WeakMap<HTMLCanvasElement, Promise<void>>();

  return {
    async mount(canvas, signal, animationLevel) {
      const previous = canvasQueues.get(canvas) ?? Promise.resolve();
      let releaseQueue!: () => void;
      const current = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      canvasQueues.set(canvas, current);
      await previous.catch(() => undefined);

      let mountedController: PilotMascotRuntimeController | undefined;
      const release = () => {
        if (mountedController) {
          mountedController.dispose();
          mountedController = undefined;
        }
        if (canvasQueues.get(canvas) === current) canvasQueues.delete(canvas);
        releaseQueue();
      };

      try {
        if (signal?.aborted) throw new DOMException('Mascot mount aborted', 'AbortError');
        mountedController = await runtime.mount(canvas, signal, animationLevel);
        if (signal?.aborted) throw new DOMException('Mascot mount aborted', 'AbortError');
        return {
          setActivity: (activity) => mountedController?.setActivity(activity),
          setZoom: (zoom) => mountedController?.setZoom(zoom),
          dispose: release,
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
