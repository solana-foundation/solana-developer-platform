import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter/index.css";
import "./index.css";
import { Toaster } from "@/components/ui/sonner";
import App from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <App />
    <Toaster richColors position="bottom-right" />
  </StrictMode>
);
