import { createRoot } from "react-dom/client";
import { BrandName } from "@/components/edition/brand-name";
import "@/styles.css";

const names = [
  ["openbot", "OpenBot"],
  ["business", "OpenBot for Business"],
  ["custom", "Acme Assistant"],
  ["prose", "OpenBot is ready"],
  ["bots", "Bots"],
];
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <main>
    <ul>
      {names.map(([id, name]) => (
        <li key={id}>
          <a href={`#${id}`}>
            <BrandName>{name}</BrandName>
          </a>
        </li>
      ))}
    </ul>
  </main>,
);
