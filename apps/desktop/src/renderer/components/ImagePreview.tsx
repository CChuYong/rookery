import { useEffect, useState } from "react";
import { useT } from "../i18n/provider.js";

// Image file tab — main reads it as a base64 data URL and we preview it with <img> (direct file:// loading isn't possible under the dev http origin).
export function ImagePreview({ path }: { path: string }): JSX.Element {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<null | "toolarge" | "unsupported" | "error">(null);

  useEffect(() => {
    let live = true;
    setUrl(null); setErr(null);
    void window.rookery.ws.readImage(path).then((r) => {
      if (!live) return;
      if (r.dataUrl) setUrl(r.dataUrl);
      else if (r.tooLarge) setErr("toolarge");
      else if (r.unsupported) setErr("unsupported");
      else setErr("error");
    }).catch(() => { if (live) setErr("error"); });
    return () => { live = false; };
  }, [path]);

  if (err) {
    const msg = err === "toolarge" ? t("imagePreview.tooLarge") : err === "unsupported" ? t("imagePreview.unsupported") : t("imagePreview.error");
    return <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted">{msg}</div>;
  }
  if (!url) return <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted">{t("common.loading")}</div>;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-ink p-4">
      <img src={url} alt={path.split("/").pop() ?? ""} className="fade-in max-h-full max-w-full object-contain" style={{ imageRendering: "auto" }} />
    </div>
  );
}
