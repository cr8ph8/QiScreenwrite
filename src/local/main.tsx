import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import LocalApp from "./LocalApp";
import "@/index.css";
import "./fonts.css";
import "./local.css";

// Local writer entry. Mounts none of the hosted providers (auth, wallet,
// subscription, site settings). Connections to the competition system and
// QiMovi are explicit panels, loaded only when the writer opens them.
createRoot(document.getElementById("root")!).render(
  <>
    <LocalApp />
    <Toaster theme="dark" position="bottom-right" closeButton richColors />
  </>,
);
