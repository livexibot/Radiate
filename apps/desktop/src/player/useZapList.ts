import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Channel } from "../api";
import type { ZapContext } from "../state/app";

const MAX = 5000;

/** The channel list the player zaps through (current group or favorites), loaded on demand. */
export function useZapList(ctx: ZapContext | null) {
  const [list, setList] = useState<Channel[] | null>(null);
  const loading = useRef<Promise<Channel[]> | null>(null);
  const key = ctx ? `${ctx.groupId}|${ctx.favoritesOnly}` : "";

  useEffect(() => {
    setList(null);
    loading.current = null;
  }, [key]);

  const load = useCallback(async (): Promise<Channel[]> => {
    if (!ctx) return [];
    if (list) return list;
    loading.current ??= api
      .channelsList({ groupId: ctx.groupId, favoritesOnly: ctx.favoritesOnly, includeHidden: false, offset: 0, limit: MAX })
      .then((p) => {
        setList(p.items);
        return p.items;
      });
    return loading.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, list]);

  return { list, load };
}
