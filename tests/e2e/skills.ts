import type { Browser } from "@e2e-dev/web";

export type TestSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  global?: boolean;
};

export async function installSkill(browser: Browser, skill: TestSkill) {
  const result = await browser.evaluate(async (skill) => {
    const response = await fetch("/api/plugins/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(skill),
    });
    return {
      status: response.status,
      error: response.ok ? "" : await response.text(),
    };
  }, skill);
  if (result.status !== 200) {
    throw new Error(
      `Could not install ${skill.slug}: ${result.status} ${result.error}`,
    );
  }
}

export async function grantSkill(
  browser: Browser,
  agentId: string,
  ref: string,
) {
  const result = await browser.evaluate(
    async ({ agentId, ref }) => {
      const response = await fetch("/api/plugins/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "skill", ref, agentId }),
      });
      return {
        status: response.status,
        error: response.ok ? "" : await response.text(),
      };
    },
    { agentId, ref },
  );
  if (result.status !== 200) {
    throw new Error(`Could not grant ${ref}: ${result.status} ${result.error}`);
  }
}
