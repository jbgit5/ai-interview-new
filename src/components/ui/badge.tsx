import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-violet-600/90 text-white",
        secondary: "border-slate-700 bg-slate-800 text-slate-200",
        success: "border-emerald-800/50 bg-emerald-950/80 text-emerald-300",
        warning: "border-amber-800/50 bg-amber-950/80 text-amber-200",
        danger: "border-red-800/50 bg-red-950/80 text-red-200",
        outline: "border-slate-600 text-slate-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
