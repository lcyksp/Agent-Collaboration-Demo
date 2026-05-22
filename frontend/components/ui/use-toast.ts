"use client";

import { useCallback } from "react";

export function useToast() {
  const toast = useCallback((opts: { title: string; description?: string }) => {
    if (typeof window !== "undefined") {
      console.info(`[toast] ${opts.title} ${opts.description ?? ""}`);
    }
  }, []);

  return { toast };
}
