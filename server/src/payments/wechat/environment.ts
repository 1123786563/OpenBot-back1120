/**
 * Payment environment guidance for the cashier (#69 AC5).
 *
 * Desktop external browsers show the Native QR; SUPPORTED external mobile
 * browsers go through H5. WeChat's built-in browser, embedded WebViews and
 * other unsupported environments must be told to open a supported system
 * browser — repeatedly attempting to wake WeChat is explicitly NOT offered,
 * and long-pressing a desktop Native QR on the same phone is NEVER a general
 * solution. The return URL is a server-side whitelist item and is never
 * evidence of payment.
 */

export type PaymentEnvironmentClass =
  | "desktop"
  | "external_mobile_browser"
  | "wechat_internal_browser"
  | "webview_or_unsupported";

export type PaymentEnvironmentGuidance =
  | { readonly kind: "native_qr" }
  | { readonly kind: "h5_redirect" }
  | {
      readonly kind: "unsupported_environment";
      /** Tell the user to open a supported system browser; never auto-wake WeChat. */
      readonly hint: string;
    };

export function classifyPaymentEnvironment(input: {
  readonly isMobile: boolean;
  readonly isWechatInternalBrowser: boolean;
  readonly isEmbeddedWebview: boolean;
}): PaymentEnvironmentClass {
  if (input.isWechatInternalBrowser) return "wechat_internal_browser";
  if (input.isEmbeddedWebview) return "webview_or_unsupported";
  return input.isMobile ? "external_mobile_browser" : "desktop";
}

/**
 * Which action a given environment may present. The Native QR is a DESKTOP
 * artifact: a phone scanning it from a second device pays in WeChat on THAT
 * device. This function never claims same-device long-press support.
 */
export function guidanceFor(
  environment: PaymentEnvironmentClass,
  available: { readonly native: boolean; readonly h5: boolean },
): PaymentEnvironmentGuidance {
  switch (environment) {
    case "desktop":
      return available.native
        ? { kind: "native_qr" }
        : {
            kind: "unsupported_environment",
            hint: "desktop browser cannot present H5; use the QR code on a desktop screen",
          };
    case "external_mobile_browser":
      return available.h5
        ? { kind: "h5_redirect" }
        : {
            kind: "unsupported_environment",
            hint: "this browser is not a supported H5 target; open the desktop QR flow",
          };
    case "wechat_internal_browser":
    case "webview_or_unsupported":
      return {
        kind: "unsupported_environment",
        hint: "open this page in the system browser (Safari/Chrome) to pay; payments inside WeChat's built-in browser or an embedded WebView are not supported",
      };
  }
}
