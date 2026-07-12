import { useEffect, useState } from "react";

export interface ViewportSize {
  width: number;
  height: number;
}

function readViewport(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState(readViewport);

  useEffect(() => {
    const update = (): void => setSize(readViewport());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return size;
}
