import { OPENBOT_UI } from "@/lib/copilot/a2ui";
import "@copilotkit/react-core/v2/styles.css";
import "@/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const definition = OPENBOT_UI.components.get("TextField");
if (!definition) throw new Error("Missing TextField");
const Field = definition.component;

function ResettableNumber() {
  const [value, setValue] = useState<unknown>(200);
  return (
    <main>
      <Field
        label="Amount"
        variant="number"
        value={value}
        setValue={setValue}
      />
      <button type="button" onClick={() => setValue(7)}>
        Load seven
      </button>
      <button type="button" onClick={() => setValue(0)}>
        Load zero
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The number field fixture needs a root");
createRoot(root).render(<ResettableNumber />);
