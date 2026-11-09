import * as React from "react"
import { cn } from "@/lib/utils"

/** One field style: white, hairline border, 48px. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-xl border border-line bg-white px-4 py-1 text-base text-fg outline-none transition-[color,box-shadow] placeholder:text-fg-3 focus-visible:border-fg focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
