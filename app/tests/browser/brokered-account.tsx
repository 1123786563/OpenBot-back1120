import { useBrokeredAccount } from "@/components/plugins/brokered-account-row";
import "@/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";

const client = new QueryClient();

function RecordedAccount() {
  const { disconnect, probe, recheck, verified, verifiedAt } =
    useBrokeredAccount({
      serverId: "gmail",
      brokered: true,
      configured: true,
      recorded: true,
      verified: false,
      verifiedAt: null,
      probe: null,
      checkable: true,
      reconnectsInPlace: false,
      authScheme: "API_KEY",
      returnTo: "settings",
      report: () => {},
    });

  return (
    <main>
      <dl>
        <dt>Verified</dt>
        <dd data-testid="verified">{String(verified)}</dd>
        <dt>Checked at</dt>
        <dd data-testid="verified-at">{String(verifiedAt)}</dd>
        <dt>Probe</dt>
        <dd data-testid="probe">{String(probe)}</dd>
      </dl>
      <button onClick={recheck} type="button">
        Re-check
      </button>
      <button onClick={disconnect} type="button">
        Disconnect
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The brokered account fixture needs a root");
createRoot(root).render(
  <QueryClientProvider client={client}>
    <RecordedAccount />
  </QueryClientProvider>,
);
