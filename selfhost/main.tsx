import { createRoot } from "react-dom/client";
import { Workspace } from "./Workspace";
import "./workspace.css";

const root = document.getElementById("root")!;
createRoot(root).render(<Workspace />);
