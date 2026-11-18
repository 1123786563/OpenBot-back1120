import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import { ui } from "@/lib/i18n";

export function WorkspaceRow() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const save = useMutation({
    mutationFn: (name: string) =>
      client("/api/workspace", {
        method: "PATCH",
        body: { name },
        fallback: ui("Could not save your workspace name."),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.currentUser() });
      setDraft(null);
    },
  });
  if (!user?.workspace) return null;
  const name = draft ?? user.workspace.name;
  return (
    <PageSection title={ui("Your workspace")}>
      <PageRows>
        <form
          className="flex flex-col gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate(name.trim());
          }}
        >
          <label htmlFor={inputId}>{ui("Workspace name")}</label>
          <Input
            id={inputId}
            value={name}
            required
            maxLength={80}
            disabled={save.isPending}
            onChange={(event) => {
              setDraft(event.target.value);
              save.reset();
            }}
          />
          <p className="text-sm text-muted-foreground">
            {ui("You own this personal workspace.")}
          </p>
          {save.error ? <p role="alert">{save.error.message}</p> : null}
          {save.isSuccess ? (
            <p role="status">{ui("Workspace name saved.")}</p>
          ) : null}
          <Button
            className="self-end"
            type="submit"
            disabled={save.isPending || !name.trim()}
          >
            {save.isPending ? ui("Saving…") : ui("Save workspace name")}
          </Button>
        </form>
      </PageRows>
    </PageSection>
  );
}
