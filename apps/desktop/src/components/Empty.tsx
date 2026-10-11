import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-ico">
        <Icon name={icon} />
      </span>
      <b>{title}</b>
      {children ? <div className="empty-actions">{children}</div> : null}
    </div>
  );
}
