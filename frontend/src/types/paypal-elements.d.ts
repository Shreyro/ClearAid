import type { DetailedHTMLProps, HTMLAttributes } from "react";

// Web components registered by the PayPal JavaScript SDK v6.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { type?: "pay" | "donate" | "checkout" | "buynow" | "subscribe" };
    }
  }
}
