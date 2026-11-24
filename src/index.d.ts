export declare const COURIER_VERSION: 1;
export declare const OUTBOX_ROUTE: "courier/outbox";
export declare const INBOX_ROUTE: "courier/inbox";

export interface CourierLimits {
  itemsPerHandoff: number;
  maxItemsPerHandoff: number;
  handoffsPerRun: number;
  wantsPerReceiver: number;
  idLength: number;
  nameLength: number;
  bookmarkLength: number;
  itemBytes: number;
}
export declare const DEFAULT_LIMITS: Readonly<CourierLimits>;

/** One item of news. `id` is unique per sender and topic; a receiver ignores an id it has. */
export interface CourierItem {
  id: string;
  /** When it happened, as an ISO 8601 time. */
  at: string;
  data: Record<string, unknown>;
}

export interface CourierProblem {
  plugin: string;
  code: string;
  route?: string;
  from?: string;
  topic?: string;
}

export interface CourierReport {
  receivers: number;
  handoffs: number;
  delivered: number;
  /** True when the run stopped at its limit with news still waiting. */
  unfinished: boolean;
  problems: CourierProblem[];
}

/** The part of EmDash's runtime the courier uses. */
export interface CourierRuntime {
  configuredPlugins?: ReadonlyArray<{ id: string }>;
  sandboxedPlugins?: { keys(): Iterable<string> };
  sandboxedPluginEntries?: ReadonlyArray<{ id: string }>;
  /** EmDash's Kysely database, used read-only for `_plugin_state.registry_slug` resolution. */
  db?: { selectFrom?(table: never): unknown };
  getPluginRouteMeta(pluginId: string, path: string): { public?: boolean } | null;
  handlePluginApiRoute(
    pluginId: string,
    method: string,
    path: string,
    request: Request,
  ): Promise<{ success: boolean; data?: unknown; error?: { code?: string } }>;
}

export interface CourierOptions {
  /** Lower limits for this run; each is capped at its locked value in `DEFAULT_LIMITS`. */
  limits?: Partial<CourierLimits>;
  /** Optional explicit mapping from a requested sender name (`want.from`) to an installed outbox plugin id. */
  senders?: Readonly<Record<string, string>>;
}

export declare function installedPluginIds(runtime: CourierRuntime): string[];
export declare function findDoors(
  runtime: CourierRuntime,
  ids?: string[],
): { outboxes: string[]; inboxes: string[]; problems: CourierProblem[] };
export declare function runCourier(runtime: CourierRuntime, options?: CourierOptions): Promise<CourierReport>;
