import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"
import { SealLoader } from "@/components/seal-loader"

/**
 * The site's pill buttons: primary = ink fill with paper text, quiet = outline, ghost = text. 48px (lg) or 44px (default).
 * `busy` disables the button and puts the turning seal before its (already "…ing") words.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full border text-[15px] font-semibold whitespace-nowrap transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-40 data-busy:disabled:opacity-80 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "border-fg bg-fg text-bg hover:border-fg-2 hover:bg-fg-2",
        quiet: "border-line bg-transparent text-fg hover:bg-line",
        ghost: "border-transparent bg-transparent text-fg-2 hover:bg-line hover:text-fg",
      },
      size: {
        default: "h-11 px-5",
        lg: "h-12 px-6",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  busy = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    busy?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={asChild ? disabled : disabled || busy}
      {...(busy ? { "aria-busy": true, "data-busy": "" } : {})}
      {...props}
    >
      {busy && !asChild ? (
        <>
          <SealLoader size={16} />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
