/**
 * Routeis Partner API — typed client (Node.js / TypeScript)
 * Base URL: https://api.cmpdr.dev/v1
 *
 * SECURITY — read this first:
 * - The API key comes ONLY from the server-side env var ROUTEIS_API_KEY.
 *   Never put it in frontend code, never commit it, never log it.
 * - Delivery content is a secret too: this client never logs it, and
 *   neither should your code. Store it encrypted and hand it to the
 *   buyer through your own secure channel, then don't keep it in logs.
 * - Money is ALWAYS a string, never a JS number. A price can have more
 *   than 2 decimals (e.g. "0.954163") and that exact amount is charged.
 *   Never round, never parseFloat() a price for charging.
 *
 * CATALOG KEYING:
 * - Never key your catalog off `name`: the name/description come back in
 *   the API account's own language (meta.locale) and can change.
 * - Key off `id` or `productRef` (the stable internal code). POST /orders
 *   accepts that stable code in the `productName` field — that is why
 *   createOrder()'s first argument is called productName but you should
 *   pass the productRef, not the localized display name.
 *
 * IDEMPOTENCY (critical):
 * - externalOrderId is REQUIRED and unique per account. Use your real
 *   shop order id (e.g. "shop-1001"), never a random value per retry.
 * - Retrying POST /orders with the SAME externalOrderId returns the
 *   SAME order and NEVER charges twice. On a replay, `balanceAfter`
 *   is omitted — that is how you can tell it was a replay.
 * - Reusing it with a DIFFERENT body returns 422 IDEMPOTENCY_MISMATCH.
 *   So: on network timeout, retry with the exact same arguments.
 */

export type Money = string; // decimal string, at least 2 decimal places, e.g. "0.954163"

export type RouteisErrorCode =
  | "INVALID_API_KEY"
  | "INSUFFICIENT_BALANCE"
  | "OUT_OF_STOCK"
  | "PRODUCT_NOT_FOUND"
  | "INVALID_QUANTITY"
  | "RATE_LIMIT_EXCEEDED"
  | "IDEMPOTENCY_MISMATCH"
  | "ORDER_IN_PROGRESS"
  | "MAINTENANCE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNKNOWN_ERROR";

export class RouteisApiError extends Error {
  readonly code: RouteisErrorCode;
  readonly status: number;
  readonly requestId?: string;

  constructor(code: RouteisErrorCode, message: string, status: number, requestId?: string) {
    super(message);
    this.name = "RouteisApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface ProductStock {
  inStock: boolean;
  count: number;
  maxQuantity: number;
}

export interface Product {
  id: number;
  name: string; // localized display name — do NOT use as a key
  productRef: string; // stable internal code — use this as the key
  deliveryType: string;
  price: Money;
  currency: string;
  stock: ProductStock;
  description?: string;
}

export interface CatalogResponse {
  data: Product[];
  meta: { locale: string };
}

export interface Balance {
  ok: boolean;
  balance: Money;
  currency: string;
}

export interface Usage {
  balance: Money;
  currency: string;
  apiOrdersTotal: number;
  apiSpendTotal: Money;
  apiOrders24h: number;
}

export interface DeliveryLine {
  content: string;
}

export interface Order {
  ok: boolean;
  orderCode: string;
  externalOrderId: string;
  status: string; // "COMPLETED" on success
  deliveryType: string;
  product: string;
  quantity: number;
  unitPrice: Money;
  totalCharged: Money;
  currency: string;
  balanceAfter?: Money; // OMITTED on an idempotency replay
  delivery?: { content?: string; lines?: DeliveryLine[] };
}

export interface CreateOrderResult extends Order {
  /** Normalized delivery contents: [content] for quantity 1, lines[] for quantity > 1. SECRET — never log. */
  deliveryContents: string[];
  /** True when this response was a replay of an earlier order (balanceAfter omitted). */
  isReplay: boolean;
}

export interface OrderListResponse {
  data: Order[];
  page?: number;
  limit?: number;
  total?: number;
  [key: string]: unknown;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  reset: number | null; // unix seconds, when present
}

export interface RouteisClientOptions {
  apiKey?: string; // defaults to process.env.ROUTEIS_API_KEY
  baseUrl?: string; // defaults to https://api.cmpdr.dev/v1
  timeoutMs?: number; // default 30_000
  maxRetries?: number; // default 3 — only for 429 and for timeout/network on idempotent requests
  initialBackoffMs?: number; // default 1_000
}

/** Validate a money string without ever converting it to a float. */
export function isValidMoney(value: unknown): value is Money {
  return typeof value === "string" && /^\d+\.\d{2,}$/.test(value);
}

/** Compare two money strings exactly (no floats). Returns -1, 0 or 1. */
export function compareMoney(a: Money, b: Money): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(scale, "0"));
  const bv = BigInt(bi + bf.padEnd(scale, "0"));
  return av < bv ? -1 : av > bv ? 1 : 0;
}

const DEFAULT_BASE_URL = "https://api.cmpdr.dev/v1";

/** Read an env var without depending on @types/node (works in plain Node). */
function envVar(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RouteisClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;

  /** Last rate-limit headers seen (null until the first protected call). */
  public lastRateLimit: RateLimitInfo | null = null;

  constructor(options: RouteisClientOptions = {}) {
    const apiKey = options.apiKey ?? envVar("ROUTEIS_API_KEY");
    if (!apiKey) {
      throw new Error(
        "ROUTEIS_API_KEY is not set. Set it as a server-side environment variable — never hardcode it.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? envVar("ROUTEIS_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
  }

  // ---------------------------------------------------------------- endpoints

  /** GET /health — no auth. */
  async health(): Promise<{ ok: boolean; service: string; version: number }> {
    return this.request("GET", "/health", undefined, { auth: false });
  }

  /** GET /balance — { ok, balance, currency }. */
  async getBalance(): Promise<Balance> {
    return this.request("GET", "/balance");
  }

  /** GET /catalog/products — ?description=true includes description (default false). */
  async listProducts(options: { description?: boolean } = {}): Promise<CatalogResponse> {
    const qs = options.description ? "?description=true" : "";
    return this.request("GET", `/catalog/products${qs}`);
  }

  /**
   * GET /catalog/products/{ref} — ref may be numeric id, productRef, or
   * (discouraged, locale-dependent) product name. Prefer productRef.
   */
  async getProduct(
    ref: string | number,
    options: { description?: boolean } = {},
  ): Promise<Product & { locale?: string }> {
    const qs = options.description === false ? "?description=false" : "";
    return this.request("GET", `/catalog/products/${encodeURIComponent(String(ref))}${qs}`);
  }

  /**
   * POST /orders — idempotent by externalOrderId.
   *
   * @param productName Pass the stable productRef here (the API field is
   *   named productName, but the value should be the productRef, NOT the
   *   localized display name, which changes with locale).
   * @param quantity Integer >= 1 (default 1).
   * @param externalOrderId Your real, unique shop order id, e.g. "shop-1001".
   *   Reuse the EXACT same value (and body) on retries — never generate a
   *   new one per attempt, or a timeout retry could double-charge.
   */
  async createOrder(
    productName: string,
    quantity = 1,
    externalOrderId: string,
  ): Promise<CreateOrderResult> {
    if (!productName) throw new Error("createOrder: productName (productRef) is required.");
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new RouteisApiError("INVALID_QUANTITY", "quantity must be an integer >= 1.", 400);
    }
    if (!externalOrderId) {
      throw new Error("createOrder: externalOrderId is required and must be unique per account.");
    }
    const order = await this.request<Order>(
      "POST",
      "/orders",
      { productName, quantity, externalOrderId },
      { idempotent: true },
    );
    return {
      ...order,
      deliveryContents: extractDeliveryContents(order),
      isReplay: order.balanceAfter === undefined,
    };
  }

  /** Same as createOrder, but by numeric product id (POST body uses productId). */
  async createOrderById(
    productId: number,
    quantity = 1,
    externalOrderId: string,
  ): Promise<CreateOrderResult> {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new RouteisApiError("INVALID_QUANTITY", "quantity must be an integer >= 1.", 400);
    }
    if (!externalOrderId) {
      throw new Error("createOrderById: externalOrderId is required and must be unique per account.");
    }
    const order = await this.request<Order>(
      "POST",
      "/orders",
      { productId, quantity, externalOrderId },
      { idempotent: true },
    );
    return {
      ...order,
      deliveryContents: extractDeliveryContents(order),
      isReplay: order.balanceAfter === undefined,
    };
  }

  /** GET /orders?page=&limit=&externalOrderId= — paginated list of API orders. */
  async listOrders(params: { page?: number; limit?: number; externalOrderId?: string } = {}): Promise<OrderListResponse> {
    const qs = new URLSearchParams();
    if (params.page !== undefined) qs.set("page", String(params.page));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.externalOrderId) qs.set("externalOrderId", params.externalOrderId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/orders${suffix}`);
  }

  /** GET /orders/{orderCode} — order detail + delivery content. SECRET — never log the result's delivery. */
  async getOrder(orderCode: string): Promise<Order> {
    if (!orderCode) throw new Error("getOrder: orderCode is required.");
    return this.request("GET", `/orders/${encodeURIComponent(orderCode)}`);
  }

  /** GET /usage — balance, totals and last-24h order count. */
  async getUsage(): Promise<Usage> {
    return this.request("GET", "/usage");
  }

  // ------------------------------------------------------------- internals

  private updateRateLimit(headers: Headers): void {
    const num = (name: string): number | null => {
      const v = headers.get(name);
      return v === null ? null : Number(v);
    };
    this.lastRateLimit = {
      limit: num("X-RateLimit-Limit"),
      remaining: num("X-RateLimit-Remaining"),
      reset: num("X-RateLimit-Reset"),
    };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { auth?: boolean; idempotent?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth !== false;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(auth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        this.updateRateLimit(res.headers);

        const text = await res.text();
        const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

        if (res.status === 429) {
          const err = toApiError(json, res.status, "RATE_LIMIT_EXCEEDED");
          if (attempt < this.maxRetries) {
            // Respect Retry-After (seconds) first, then exponential backoff.
            const retryAfter = res.headers.get("Retry-After");
            const base = retryAfter !== null ? Number(retryAfter) * 1_000 : this.initialBackoffMs;
            await sleep(base * 2 ** attempt);
            attempt += 1;
            continue;
          }
          throw err;
        }

        if (!res.ok || json.ok === false) {
          throw toApiError(json, res.status);
        }
        return json as T;
      } catch (err) {
        const isTimeout =
          err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        const isNetwork =
          err instanceof TypeError || (err instanceof Error && /fetch failed|network/i.test(err.message));
        // Only retry timeouts/network errors, and only when the call is
        // safe to repeat: GETs always, POSTs only via externalOrderId
        // idempotency (same body, same externalOrderId — never regenerated).
        const safeToRetry = method === "GET" || opts.idempotent === true;
        if ((isTimeout || isNetwork) && safeToRetry && attempt < this.maxRetries) {
          await sleep(this.initialBackoffMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        if (err instanceof RouteisApiError) throw err;
        if (isTimeout) throw new RouteisApiError("TIMEOUT", "Request timed out.", 0);
        throw new RouteisApiError(
          "NETWORK_ERROR",
          err instanceof Error ? err.message : "Network error.",
          0,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** Normalize delivery: {content} for quantity 1, lines[] for quantity > 1. */
export function extractDeliveryContents(order: Order): string[] {
  if (order.delivery?.lines?.length) return order.delivery.lines.map((l) => l.content);
  if (order.delivery?.content !== undefined) return [order.delivery.content];
  return [];
}

function toApiError(
  json: Record<string, unknown>,
  status: number,
  fallbackCode: RouteisErrorCode = "UNKNOWN_ERROR",
): RouteisApiError {
  const e = json.error as { code?: string; message?: string; requestId?: string } | undefined;
  const code = (e?.code as RouteisErrorCode | undefined) ?? fallbackCode;
  return new RouteisApiError(code, e?.message ?? `Routeis API error (HTTP ${status}).`, status, e?.requestId);
}
