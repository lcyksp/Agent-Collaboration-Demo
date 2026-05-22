"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none",
        "focus:ring-2 focus:ring-slate-400",
        className
      )}
      {...props}
    />
  );
}
