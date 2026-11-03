import type { SignIn } from "@clerk/nextjs";
import type { ComponentProps } from "react";

const UNDERLINE_FIELD_CLASS =
  "rounded-none border-0 border-b border-border-default bg-transparent text-field text-primary shadow-none outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-none focus-visible:shadow-none";

const SECONDARY_BUTTON_CLASS =
  "h-10 rounded-control border-0 bg-fill bg-none text-body font-medium text-primary shadow-none hover:bg-fill-strong focus-visible:shadow-none";

// Clerk's prebuilt sign-in and sign-up drawn as a refresh-design form: no card, a left-aligned
// header, underline fields and the design system's buttons. The auth shell draws the brand
// and the account link, so Clerk's logo and footer are off.
export const authAppearance = {
  options: {
    logoPlacement: "none",
    socialButtonsVariant: "blockButton",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full max-w-none rounded-none border-0 bg-transparent shadow-none",
    card: "gap-8 rounded-none border-0 bg-transparent p-0 text-left shadow-none",
    header: "items-start gap-2 text-left",
    headerTitle: "text-heading font-medium text-primary",
    headerSubtitle:
      "text-body text-secondary [.cl-signIn-start_&]:hidden [.cl-signUp-start_&]:hidden",
    backRow: "w-full justify-start",
    backLink: "text-body text-secondary hover:text-primary",
    main: "gap-6",
    footer: "hidden",
    formFieldLabel: "text-meta font-medium text-primary",
    formFieldAction: "text-meta font-medium text-primary hover:underline",
    formFieldInput: `h-9 px-0.5 ${UNDERLINE_FIELD_CLASS}`,
    formFieldInputShowPasswordButton: "text-secondary hover:bg-transparent hover:text-primary",
    formFieldErrorText: "text-meta text-error",
    formButtonPrimary:
      "h-10 rounded-control bg-primary bg-none text-body font-medium text-on-primary shadow-none hover:bg-primary hover:opacity-90 focus-visible:shadow-none",
    buttonArrowIcon: "hidden",
    lastAuthenticationStrategyBadge: "hidden",
    formButtonReset: "text-body text-secondary hover:bg-transparent hover:text-primary",
    otpCodeFieldInputs: "w-full justify-between gap-2",
    otpCodeFieldInput: `h-10 flex-1 ${UNDERLINE_FIELD_CLASS}`,
    otpCodeFieldErrorText: "text-meta text-error",
    formResendCodeLink: "text-meta text-tertiary hover:text-primary",
    identityPreview: "justify-start gap-2 border-0 bg-transparent p-0 shadow-none",
    identityPreviewText: "text-body text-primary",
    identityPreviewEditButton: "text-secondary hover:text-primary",
    socialButtonsBlockButton: SECONDARY_BUTTON_CLASS,
    socialButtonsBlockButtonText: "text-body font-medium",
    // The forgot-password step draws its main action, "Reset your password", with the same element
    // as the other methods; it is the one placed directly in the main column.
    alternativeMethodsBlockButton: `${SECONDARY_BUTTON_CLASS} justify-start px-4 [.cl-main>&]:justify-center [.cl-main>&]:bg-primary [.cl-main>&]:text-on-primary [.cl-main>&]:hover:bg-primary [.cl-main>&]:hover:opacity-90`,
    alternativeMethodsBlockButtonText: "text-body font-medium",
    alternativeMethodsBlockButtonArrow: "hidden",
    dividerLine: "bg-border-default",
    dividerText: "text-meta text-tertiary",
    alert: "rounded-control border border-error-border bg-error-bg shadow-none",
    alertText: "text-meta text-error",
  },
} satisfies ComponentProps<typeof SignIn>["appearance"];
