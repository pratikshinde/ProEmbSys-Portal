const RAZORPAY_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js"

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void }
  }
}

/** Injects the Razorpay Checkout script once and resolves true on load
 *  (false on failure) — shared by the PCB pay button and Shop checkout so
 *  the loading logic exists in exactly one place. */
export function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false)
      return
    }
    if (window.Razorpay) {
      resolve(true)
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SCRIPT_SRC}"]`)
    if (existing) {
      existing.addEventListener("load", () => resolve(true))
      existing.addEventListener("error", () => resolve(false))
      return
    }
    const script = document.createElement("script")
    script.src = RAZORPAY_SCRIPT_SRC
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.body.appendChild(script)
  })
}
