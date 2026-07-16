import { useRef, useState } from "react";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { baseName } from "../lib/path.js";

export function RepoModal(p: {
  repos: { name: string; path: string }[];
  onRegister: (r: { name: string; path: string; description: string }) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
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
      className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("repoModal.title")}
        className={cn("w-[480px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}
      >
        <div className="mb-3 text-[14px] font-semibold">{t("repoModal.title")}</div>
        <div className="flex flex-col gap-2">
          <Input autoFocus placeholder={t("repoModal.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          {nameTaken && <p className="text-[11.5px] text-fail">{t("repoModal.nameTaken")}</p>}
          <div className="flex gap-2">
            <Input className="flex-1" placeholder={t("repoModal.pathPlaceholder")} value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} />
            <Button
              variant="outline"
              onClick={async () => {
                const picked = await window.rookery.pickDirectory();
                if (picked) setF((x) => ({ ...x, path: picked, name: x.name || baseName(picked) }));
              }}
            >
              {t("repoModal.browse")}
            </Button>
          </div>
          {pathTaken && <p className="text-[11.5px] text-fail">{t("repoModal.pathTaken")}</p>}
          <Input placeholder={t("repoModal.descPlaceholder")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </div>
        <p className="mt-2 text-[11.5px] text-muted">{t("repoModal.pathHint")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={register} disabled={!name || !path || nameTaken || pathTaken}>{t("repoModal.register")}</Button>
        </div>
      </div>
    </div>
  );
}
