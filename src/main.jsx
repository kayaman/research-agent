import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ResearchAgentV2 from "../research-agent-v2.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ResearchAgentV2 />
  </StrictMode>
);
