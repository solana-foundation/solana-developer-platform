import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WizardStepProgress } from "./wizard-step-progress";

const STEPS = ["Details", "Review", "Submit", "Complete"];

describe("WizardStepProgress", () => {
  it("announces the current step's name with how far along it is", () => {
    // The drawn name is hidden from screen readers, so the live region has to carry it.
    const markup = renderToStaticMarkup(
      <WizardStepProgress currentStep={1} progressLabel="Step 2 of 4" steps={STEPS} />
    );

    expect(markup).toMatch(
      /<span[^>]*role="status"[^>]*><span class="sr-only">Review, <\/span><span>Step 2 of 4<\/span><\/span>/
    );
  });

  it("announces only the progress when the step has no name", () => {
    const markup = renderToStaticMarkup(
      <WizardStepProgress currentStep={4} progressLabel="Step 5 of 4" steps={STEPS} />
    );

    expect(markup).toMatch(/<span[^>]*role="status"[^>]*><span>Step 5 of 4<\/span><\/span>/);
  });
});
