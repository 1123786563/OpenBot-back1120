import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <main>
    <Button>Save</Button>
    <Button render={<a href="#settings" />}>Settings</Button>
    <Button render={(props) => <a href="#agents" {...props} />}>Agents</Button>
    <Button nativeButton render={<button type="button" />}>
      Open
    </Button>
    <Item render={<button disabled type="button" />} size="sm">
      <ItemContent>
        <ItemTitle>Run now</ItemTitle>
      </ItemContent>
    </Item>
    <button type="button">Next control</button>
  </main>,
);
