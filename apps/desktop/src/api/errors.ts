import type { ApiErrorShape, ConnectionLimitError, SessionInfo } from "./types";

/** An error returned by the backend, normalised to `{ code, message, ...extra }`. */
export class ApiError extends Error implements ApiErrorShape {
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.extra = extra;
  }

  static from(raw: unknown): ApiError {
    if (raw instanceof ApiError) return raw;
    if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      const code = typeof rec.code === "string" ? rec.code : "error";
      const message = typeof rec.message === "string" ? rec.message : "Something went wrong.";
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) if (k !== "code" && k !== "message") extra[k] = v;
      return new ApiError(code, message, extra);
    }
    if (typeof raw === "string") return new ApiError("error", raw);
    if (raw instanceof Error) return new ApiError("error", raw.message);
    return new ApiError("error", "Something went wrong.");
  }
}

export function isConnectionLimit(e: unknown): e is ApiError & { extra: Omit<ConnectionLimitError, "code" | "message"> } {
  return e instanceof ApiError && e.code === "connection_limit";
}

export function limitDetails(e: ApiError): Omit<ConnectionLimitError, "code" | "message"> {
  const x = e.extra;
  return {
    sourceId: typeof x.sourceId === "string" ? x.sourceId : "",
    limit: typeof x.limit === "number" ? x.limit : 0,
    inUse: typeof x.inUse === "number" ? x.inUse : 0,
    sessions: Array.isArray(x.sessions) ? (x.sessions as SessionInfo[]) : [],
    external: typeof x.external === "number" ? x.external : 0,
  };
}

export function errorMessage(e: unknown): string {
  return ApiError.from(e).message;
}
