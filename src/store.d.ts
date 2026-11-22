import type { CourierOptions, CourierReport, CourierRuntime } from "./index.js";

export interface StoreCourierOptions extends CourierOptions {
  /** For tests: stands in for `withEmDashRuntime` from "emdash/middleware". */
  withEmDashRuntime?: <T>(run: (runtime: CourierRuntime) => T | Promise<T>) => Promise<T>;
}

/** One courier run; a run already going in this process is shared. Never rejects. */
export declare function courierTick(options?: StoreCourierOptions): Promise<CourierReport | null>;

/** A Worker `scheduled()` handler for the store's once-a-minute timer. */
export declare function courierScheduled(
  options?: StoreCourierOptions,
): (controller: unknown, env: unknown, ctx: { waitUntil(promise: Promise<unknown>): void }) => Promise<CourierReport | null>;
