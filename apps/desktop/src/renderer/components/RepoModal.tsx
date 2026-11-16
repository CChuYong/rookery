import { useId, useRef, useState } from "react";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useT } from "../i18n/provider.js";
import { baseName } from "../lib/path.js";
import { dialogOverlayClass, dialogPanelClass } from "../ui/dialog.js";

export function RepoModal(p: {
  repos: { name: string; path: string }[];
  onRegister: (r: { name: string; path: string; description: string }) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [f, setF] = useState({ name: "", path: "", description: "" });
  const { closing, dismiss } = useDismissTransition(p.onClose);
  // trim-based duplicate validation
  const name = f.name.trim();
  const path = f.path.trim();
  const nameTaken = name !== "" && p.repos.some((r) => r.name === name);
  const pathTaken = path !== "" && p.repos.some((r) => r.path === path);
  const register = () => { if (name && path && !nameTaken && !pathTaken) { p.onRegister({ name, path, description: f.description.trim() }); dismiss(); } };
  useModalKeys({ escape: "ignore", onSubmit: register });
  useFocusTrap(panelRef);
  return (
    <div
      className={dialogOverlayClass({ closing })}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("repoModal.title")}
        className={dialogPanelClass({ size: "md", closing })}
      >
        <div className="mb-4 text-title font-medium text-fg">{t("repoModal.title")}</div>
        {/* Visible labels (audit #77): a placeholder alone vanishes once typed into. Errors are tied to their field. */}
        <div className="flex flex-col gap-2.5">
          <label htmlFor={`${id}-name`} className="-mb-1.5 text-ui text-fg-dim">{t("repoModal.nameLabel")}</label>
          <Input
            id={`${id}-name`}
            autoFocus
            placeholder={t("repoModal.namePlaceholder")}
            value={f.name}
            aria-invalid={nameTaken || undefined}
            aria-describedby={nameTaken ? `${id}-name-err` : undefined}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          {nameTaken && <p id={`${id}-name-err`} className="text-ui text-fail">{t("repoModal.nameTaken")}</p>}
          <label htmlFor={`${id}-path`} className="-mb-1.5 text-ui text-fg-dim">{t("repoModal.pathLabel")}</label>
          <div className="flex gap-2">
            <Input
              id={`${id}-path`}
              className="min-w-0 flex-1"
              placeholder={t("repoModal.pathPlaceholder")}
              value={f.path}
              aria-invalid={pathTaken || undefined}
              aria-describedby={pathTaken ? `${id}-path-err ${id}-hint` : `${id}-hint`}
              onChange={(e) => setF({ ...f, path: e.target.value })}
            />
            <Button
              variant="outline"
              size="md"
              onClick={async () => {
                const picked = await window.rookery.pickDirectory();
                if (picked) setF((x) => ({ ...x, path: picked, name: x.name || baseName(picked) }));
              }}
            >
              {t("repoModal.browse")}
            </Button>
          </div>
          {pathTaken && <p id={`${id}-path-err`} className="text-ui text-fail">{t("repoModal.pathTaken")}</p>}
          <label htmlFor={`${id}-desc`} className="-mb-1.5 text-ui text-fg-dim">{t("repoModal.descLabel")}</label>
          <Input id={`${id}-desc`} placeholder={t("repoModal.descPlaceholder")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </div>
        <p id={`${id}-hint`} className="mt-2 text-ui leading-relaxed text-muted">{t("repoModal.pathHint")}</p>
        <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="outline" size="md" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" size="md" onClick={register} disabled={!name || !path || nameTaken || pathTaken}>{t("repoModal.register")}</Button>
        </div>
      </div>
    </div>
  );
}
