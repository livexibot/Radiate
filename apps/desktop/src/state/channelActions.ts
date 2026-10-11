import { useCallback } from "react";
import { api, errorMessage, type Channel } from "../api";
import type { MenuItem } from "../components/ContextMenu";
import { useApp } from "./app";

export function useChannelActions() {
  const { toast, bump } = useApp();
  const setFavorite = useCallback(
    async (c: Channel, favorite: boolean) => {
      try {
        await api.channelSetFavorite(c.id, favorite);
        toast(favorite ? `${c.name} added to favorites` : `${c.name} removed from favorites`, "good");
        bump();
      } catch (e) {
        toast(errorMessage(e), "bad");
      }
    },
    [toast, bump],
  );
  const hide = useCallback(
    async (c: Channel) => {
      try {
        await api.channelSetHidden(c.id, true);
        toast(`${c.name} hidden`);
        bump();
      } catch (e) {
        toast(errorMessage(e), "bad");
      }
    },
    [toast, bump],
  );
  const menuFor = useCallback(
    (c: Channel, extra: MenuItem[] = []): MenuItem[] => [
      ...extra,
      { label: c.favorite ? "Remove from favorites" : "Add to favorites", icon: "star", onSelect: () => void setFavorite(c, !c.favorite) },
      { label: "Hide channel", icon: "eyeOff", onSelect: () => void hide(c) },
    ],
    [setFavorite, hide],
  );
  return { setFavorite, hide, menuFor };
}
