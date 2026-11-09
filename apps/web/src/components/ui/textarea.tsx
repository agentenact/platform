import * as React from "react"
import { cn } from "@/lib/utils"

/** Same field style as Input. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 w-full rounded-xl border border-line bg-white px-4 py-3 text-base text-fg outline-none transition-[color,box-shadow] placeholder:text-fg-3 focus-visible:border-fg focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
