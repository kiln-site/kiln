import * as React from "react"
import {
  toast as sonnerToast,
  Toaster as Sonner,
  type ExternalToast,
  type ToasterProps,
} from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

export type AppToastType =
  | "default"
  | "error"
  | "info"
  | "loading"
  | "success"
  | "warning"

export interface ShowToastOptions extends ExternalToast {
  message: React.ReactNode
  type?: AppToastType
}

type ToasterStyle = React.CSSProperties & { "--width": string }

const defaultToasterStyle: ToasterStyle = { "--width": "25rem" }

/** How many toasts show at once; newer ones push older ones out of view. */
export const visibleToastLimit = 4

const Toaster = React.memo(function Toaster({
  className,
  style,
  ...props
}: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      offset={{ top: 12 }}
      mobileOffset={{ top: 8, left: 8, right: 8 }}
      gap={8}
      visibleToasts={visibleToastLimit}
      closeButton
      className={cn("kiln-toaster", className)}
      style={{ ...defaultToasterStyle, ...style }}
      containerAriaLabel="Notifications"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-emerald-400 light:text-emerald-700" />
        ),
        info: <InfoIcon className="size-4 text-sky-400 light:text-sky-700" />,
        warning: (
          <TriangleAlertIcon className="size-4 text-amber-300 light:text-amber-700" />
        ),
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: (
          <Loader2Icon className="size-4 animate-spin text-primary-ink" />
        ),
        close: <XIcon className="size-4" />,
      }}
      {...props}
    />
  )
})

export { Toaster }

export function showToast({
  message,
  type = "default",
  ...options
}: ShowToastOptions): number | string {
  switch (type) {
    case "error":
      return sonnerToast.error(message, options)
    case "info":
      return sonnerToast.info(message, options)
    case "loading":
      return sonnerToast.loading(message, options)
    case "success":
      return sonnerToast.success(message, options)
    case "warning":
      return sonnerToast.warning(message, options)
    default:
      return sonnerToast(message, options)
  }
}

export function dismissToast(id?: number | string): number | string {
  return sonnerToast.dismiss(id)
}
