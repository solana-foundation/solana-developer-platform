import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "ds-typography": [
        {
          text: [
            "display",
            "title-xl",
            "title-lg",
            "title-md",
            "title-sm",
            "headline-lg",
            "headline-md",
            "body-lg",
            "body-lg-bold",
            "body-md",
            "body-md-bold",
            "body-sm",
            "body-sm-bold",
            "button-xl",
            "button-lg",
            "button-md",
            "button-sm",
            "nav-item",
            "number-lg",
            "number-md",
            "number-sm",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
