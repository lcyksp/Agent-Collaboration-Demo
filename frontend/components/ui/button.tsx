"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline";
};

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variant === "default"
          ? "bg-gradient-to-r from-slate-900 to-slate-800 text-white shadow-sm hover:from-slate-800 hover:to-slate-700 hover:shadow"
          : "border border-slate-300 bg-white/90 backdrop-blur hover:border-slate-400 hover:bg-white",
        className
      )}
      {...props}
    />
  );
}
