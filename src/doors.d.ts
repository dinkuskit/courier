import type { CourierItem } from "./index.js";

export declare const COURIER_VERSION: 1;
export declare const OUTBOX_ROUTE: "courier/outbox";
export declare const INBOX_ROUTE: "courier/inbox";

/** What a door needs from the plugin's context. */
export interface CourierDoorContext {
  kv: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    getVersioned<T>(key: string): Promise<{ value: T; revision: string } | null>;
    compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: boolean }>;
  };
}

export interface CourierDoor<Ctx> {
  public: false;
  permission: "plugins:manage";
  methods: ["POST"];
  handler(first: unknown, second?: Ctx): Promise<unknown>;
}

export interface CourierBatch {
  items: CourierItem[];
  /** The bookmark after the last item given; defaults to the one asked from. */
  next?: string | null;
  /** True when more news is waiting after `next`. */
  more?: boolean;
}

export type CourierTopicReader<Ctx> = (asked: { after: string | null; limit: number }, ctx: Ctx) => Promise<CourierBatch>;

export interface CourierWant {
  from: string;
  topic: string;
  /** Items per handoff, 1 to 100. Default 50. */
  limit?: number;
}

export interface CourierDelivery {
  from: string;
  topic: string;
  items: CourierItem[];
}

/** The `courier/outbox` route: one reader per topic this plugin sends. */
export declare function outboxDoor<Ctx = CourierDoorContext>(topics: Record<string, CourierTopicReader<Ctx>>): CourierDoor<Ctx>;

/** The `courier/inbox` route. `deliver` must ignore an item id it already has and returns how many it saved. */
export declare function inboxDoor<Ctx extends CourierDoorContext = CourierDoorContext>(doors: {
  wants: CourierWant[] | ((ctx: Ctx) => CourierWant[] | Promise<CourierWant[]>);
  deliver(delivery: CourierDelivery, ctx: Ctx): Promise<number>;
}): CourierDoor<Ctx>;

/** Whether the courier is visiting, for the plugin's admin page. */
export declare function courierStatus(
  ctx: Pick<CourierDoorContext, "kv">,
  now?: number,
): Promise<{ state: "visiting" | "late" | "missing"; lastVisit: string | null }>;
