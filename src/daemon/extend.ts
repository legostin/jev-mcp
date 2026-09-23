import type { DaemonHandle } from './main.ts';

/** Wires stage 2+ features (tasks, extension bridge, HTTP UI) into a running daemon. */
export async function registerStage2(_handle: DaemonHandle): Promise<void> {}
