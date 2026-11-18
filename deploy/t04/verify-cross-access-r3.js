/**
 * Casdoor T04 rework round 3 — the cross-access and boundary negatives the review asked for,
 * through the real pages and the real API of the deployed server on :14003.
 *
 * Run through the Agent browser (`browser_run_code_unsafe`) while `bun deploy/t04/controller.ts`
 * is running. The returned object holds only sanitized facts: names, ids, statuses, byte-equality
 * booleans, timestamps. No password, cookie, token or secret.
 *
 * Every negative is paired with the same operation succeeding for the owner, so a refusal that
 * came from something being broken cannot pass for isolation. A refusal that is really a 401
 * (anonymous) is asserted separately, so "everything failed" is distinguishable from
 * "cross-user access is refused".
 */
(async (page) => {
  const base = "http://localhost:14003";
  const control = "http://127.0.0.1:14099";
  const CASDOOR = "http://localhost:19002";
  const evidence = { scenarios: [] };
  const scenario = (name, facts) => {
    evidence.scenarios.push({ name, ...facts, at: new Date().toISOString() });
    return facts;
  };
  const now = () => new Date().toISOString();
  const RUN = `t04r3${Date.now().toString(36).slice(-5)}`;
  let stage = "init";

  async function controller(action, body) {
    const r = await fetch(`${control}${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return r.json();
  }

  const apiFor =
    (context) =>
    async (method, path, data) => {
      const response = await context.request.fetch(base + path, {
        method,
        headers: {
          Origin: base,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { data }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status(), body };
    };

  function expect(result, method, path, expected) {
    if (result.status !== expected)
      throw Error(
        `${method} ${path.split("?")[0]} expected ${expected}, got ${result.status}`,
      );
    return result.body;
  }

  async function register(domain) {
    const context = await page.context().browser().newContext();
    await context.clearCookies();
    const p = await context.newPage();
    await p.goto(`${CASDOOR}/signup/app-t04`);
    const name = `${RUN}${Math.random().toString(36).slice(2, 7)}`;
    const user = {
      name,
      email: `${name}@${domain}`,
      password:
        "T04!" +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2),
    };
    await p.getByRole("textbox", { name: "Username*", exact: true }).fill(name);
    await p.getByRole("textbox", { name: "Display name*", exact: true }).fill("T04 r3");
    await p.getByRole("textbox", { name: "Password*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Confirm*", exact: true }).fill(user.password);
    await p.getByRole("textbox", { name: "Email*", exact: true }).fill(user.email);
    await p.locator("button.signup-button").dispatchEvent("click");
    await p.waitForURL(
      (url) => url.pathname.startsWith("/result/"),
      { timeout: 30000, waitUntil: "commit" },
    );
    await p.close();
    await context.close();
    const done = await controller("/verify-user", { name });
    if (!done.verified) throw Error(`fixture verification failed for ${name}`);
    return user;
  }

  /** Sign one identity in through the real Casdoor password flow; wait for its workspace. */
  async function signIn(context, user) {
    const p = await context.newPage();
    const redirect = await context.request.fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      data: {
        provider: "casdoor",
        callbackURL: base,
        errorCallbackURL: `${base}/sign?error=AUTH_CALLBACK_FAILED`,
      },
    });
    await p.goto((await redirect.json()).url);
    await p.getByRole("textbox", { name: "Username", exact: true }).fill(user.name);
    await p.getByRole("textbox", { name: "Password", exact: true }).fill(user.password);
    await p.locator("button.login-button").dispatchEvent("click");
    await p.waitForURL((u) => u.origin === base, { timeout: 30000, waitUntil: "commit" });
    await p.waitForTimeout(1200);
    await p.close();
    for (let n = 0; n < 40; n++) {
      const session = await context.request
        .fetch(`${base}/api/auth/get-session`)
        .then((r) => r.json())
        .catch(() => null);
      if (session?.session?.activeOrganizationId)
        return { workspaceId: session.session.activeOrganizationId, userId: session.user.id };
      await page.waitForTimeout(500);
    }
    throw Error("session never named a workspace");
  }

  const signOut = async (context) => {
    const r = await context.request.fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { Origin: base },
    });
    return { status: r.status(), at: now() };
  };

  const uploadFor = (context, channelId, marker, name) =>
    context.request.fetch(`${base}/api/channels/${channelId}/attachments`, {
      method: "POST",
      headers: { Origin: base },
      multipart: {
        file: { name, mimeType: "text/plain", buffer: Buffer.from(marker, "utf8") },
      },
    });

  const mk = (s) => `${RUN}-${s}`;
  const browser = page.context().browser();

  stage = "setup-A";
  try {
    // ------------------------------------------------ A builds a space, and owner operations WORK
    const contextA = await browser.newContext({ locale: "en-US" });
    const apiA = apiFor(contextA);
    const userA = await register("t04a.example.test");
    const a = await signIn(contextA, userA);
    scenario("A signed in", { user: userA.name, workspaceId: a.workspaceId });

    const botA = expect(
      await apiA("POST", "/api/agents", {
        name: mk("A-bot"),
        title: "A only",
        roleDescription: "A's own bot",
        visibility: "public",
        systemPrompt: "Answer briefly.",
      }),
      "POST",
      "/api/agents",
      201,
    );
    const botAId = botA.agent.id;
    const channelA = expect(
      await apiA("POST", "/api/channels", { agentIds: [botAId] }),
      "POST",
      "/api/channels",
      201,
    );
    const channelAId = channelA.channel.id;
    const markerA = `T04-R3-A ${RUN}`;
    const uploadA = await uploadFor(contextA, channelAId, markerA, `${mk("a")}.txt`);
    if (uploadA.status() !== 201) throw Error(`A upload got ${uploadA.status()}`);
    const attachmentAId = (await uploadA.json()).id;

    // Owner authorized positives: edit, delete, conditional read, range read.
    const ownerGet = await contextA.request.fetch(`${base}/api/attachments/${attachmentAId}`, {
      headers: { Origin: base },
    });
    const etag = ownerGet.headers()["etag"] ?? ownerGet.headers()["ETag"];
    const ownerBytes = await ownerGet.text();
    const conditional = etag
      ? await contextA.request.fetch(`${base}/api/attachments/${attachmentAId}`, {
          headers: { Origin: base, "if-none-match": etag },
        })
      : null;
    const ranged = await contextA.request.fetch(`${base}/api/attachments/${attachmentAId}`, {
      headers: { Origin: base, range: "bytes=0-4" },
    });
    const rangedBytes = ranged.status() === 206 ? await ranged.text() : null;
    await ranged.body().catch(() => {});
    const scratch = expect(
      await apiA("POST", "/api/agents", {
        name: mk("A-scratch"),
        title: "A scratch",
        roleDescription: "to be edited and deleted by its owner",
        visibility: "private",
        systemPrompt: "x",
      }),
      "POST",
      "/api/agents",
      201,
    );
    const scratchPatched = await apiA("PATCH", `/api/agents/${scratch.agent.id}`, {
      name: mk("A-scratch"),
      title: "A scratch, edited",
      roleDescription: "edited by owner",
      visibility: "private",
    });
    const scratchDeleted = await apiA("DELETE", `/api/agents/${scratch.agent.id}`);
    scenario("A owner operations succeed", {
      botId: botAId,
      channelId: channelAId,
      attachmentId: attachmentAId,
      etagPresent: Boolean(etag),
      conditionalStatus: conditional ? conditional.status() : "no-etag",
      rangeStatus: ranged.status(),
      rangeBytes: rangedBytes,
      ownerBytesMatch: ownerBytes === markerA,
      scratchPatch: scratchPatched.status,
      scratchDelete: scratchDeleted.status,
    });
    if (ownerBytes !== markerA) throw Error("owner cannot read own bytes");
    if (scratchPatched.status !== 200) throw Error("owner cannot edit own bot");
    if (scratchDeleted.status !== 200 && scratchDeleted.status !== 204)
      throw Error("owner cannot delete own bot");

    // ------------------------------------------------ B signs in and reaches for A
    stage = "setup-B";
    const contextB = await browser.newContext({ locale: "en-US" });
    const apiB = apiFor(contextB);
    const userB = await register("t04b.example.test");
    const b = await signIn(contextB, userB);
    scenario("B signed in", { user: userB.name, workspaceId: b.workspaceId });
    if (b.workspaceId === a.workspaceId) throw Error("A and B share a workspace");

    const botB = expect(
      await apiB("POST", "/api/agents", {
        name: mk("B-bot"),
        title: "B only",
        roleDescription: "B's own bot",
        visibility: "public",
        systemPrompt: "Answer briefly.",
      }),
      "POST",
      "/api/agents",
      201,
    );
    const botBId = botB.agent.id;
    const channelB = expect(
      await apiB("POST", "/api/channels", { agentIds: [botBId] }),
      "POST",
      "/api/channels",
      201,
    );
    const channelBId = channelB.channel.id;
    const markerB = `T04-R3-B ${RUN}`;
    const uploadB = await uploadFor(contextB, channelBId, markerB, `${mk("b")}.txt`);
    if (uploadB.status() !== 201) throw Error(`B upload got ${uploadB.status()}`);
    const attachmentBId = (await uploadB.json()).id;
    scenario("B created its own", { botId: botBId, channelId: channelBId, attachmentId: attachmentBId });

    // B reaching A: plain ids, plus ORG-SUBSTITUTION variants — A's resource id with B's
    // workspace claimed by query and by header — and mixed ids and run/duplicate.
    const negB = {};
    stage = "negatives-B";
    const orgVariants = [
      ["botReadPlain", `/api/agents/${botAId}`, {}],
      ["botReadOrgQuery", `/api/agents/${botAId}?organizationId=${b.workspaceId}`, {}],
      ["botReadOrgHeader", `/api/agents/${botAId}`, { "x-organization-id": b.workspaceId }],
      ["botReadActiveOrg", `/api/agents/${botAId}`, { "x-active-organization": b.workspaceId }],
    ];
    for (const [key, path, extraHeaders] of orgVariants) {
      const r = await contextB.request.fetch(base + path, {
        method: "GET",
        headers: { Origin: base, ...(extraHeaders ?? {}) },
      });
      negB[key] = r.status();
      await r.body().catch(() => {});
    }
    negB.channelWithABot = (
      await apiB("POST", "/api/channels", {
        agentIds: [botAId],
        organizationId: b.workspaceId,
      })
    ).status;
    negB.channelWithBothBots = (
      await apiB("POST", "/api/channels", { agentIds: [botBId, botAId] })
    ).status;
    const mixed = await contextB.request.fetch(
      `${base}/api/channels/${channelBId}/attachments/${attachmentAId}`,
      { headers: { Origin: base } },
    );
    negB.mixedAttachmentRead = mixed.status();
    await mixed.body().catch(() => {});
    for (const [key, method, path, data] of [
      ["botEdit", "PATCH", `/api/agents/${botAId}`, { name: mk("A-bot"), title: "Taken by B", roleDescription: "B's now", visibility: "private" }],
      ["botDelete", "DELETE", `/api/agents/${botAId}`, undefined],
      ["botDuplicate", "POST", `/api/agents/${botAId}/duplicate`, {}],
      ["runOnABot", "POST", `/api/agents/${botAId}/run`, { message: "leak please" }],
      ["conversationRead", "GET", `/api/channels/${channelAId}`, undefined],
      ["conversationDelete", "DELETE", `/api/channels/${channelAId}`, undefined],
      ["conversationPost", "POST", `/api/channels/${channelAId}/messages`, { message: "hello" }],
      ["attachmentRead", "GET", `/api/attachments/${attachmentAId}`, undefined],
      ["attachmentHead", "HEAD", `/api/attachments/${attachmentAId}`, undefined],
      ["attachmentEtagReplay", "GET", `/api/attachments/${attachmentAId}`, undefined],
      ["attachmentDelete", "DELETE", `/api/attachments/${attachmentAId}`, undefined],
    ]) {
      const r = await contextB.request.fetch(base + path, {
        method,
        headers: {
          Origin: base,
          ...(data ? { "content-type": "application/json" } : {}),
          ...(key === "attachmentEtagReplay" && etag ? { "if-none-match": etag } : {}),
          ...(key === "attachmentEtagReplay" || key === "attachmentRead"
            ? { range: "bytes=0-4" }
            : {}),
        },
        ...(data ? { data } : {}),
      });
      negB[key] = r.status();
      await r.body().catch(() => {});
    }
    // B's lists and list-shaped searches: A's resources must not appear, whatever the query says.
    const rosterB = expect(await apiB("GET", "/api/agents"), "GET", "/api/agents", 200);
    const searchB = await apiB(
      "GET",
      `/api/agents?q=${encodeURIComponent("A only")}&search=${encodeURIComponent("A only")}`,
    );
    const channelsB = expect(
      await apiB("GET", "/api/channels?limit=50"),
      "GET",
      "/api/channels",
      200,
    );
    const connectionsB = await apiB("GET", "/api/plugins/connections");
    scenario("B reaching A by id, org substitution, search", {
      statuses: negB,
      rosterCount: rosterB.agents.length,
      rosterContainsA: rosterB.agents.some((row) => row.id === botAId),
      searchStatus: searchB.status,
      searchContainsA: (searchB.body?.agents ?? []).some((row) => row.id === botAId),
      conversationsContainA: channelsB.channels.some((row) => row.id === channelAId),
      connectionsStatus: connectionsB.status,
    });
    const refusedB = Object.entries(negB).filter(([, s]) => s === 404 || s === 403);
    if (refusedB.length !== Object.keys(negB).length)
      throw Error(`B obtained a non-refusal: ${JSON.stringify(negB)}`);
    if (rosterB.agents.some((row) => row.id === botAId)) throw Error("B roster leaks A");
    if (channelsB.channels.some((row) => row.id === channelAId))
      throw Error("B conversation list leaks A");

    // ------------------------------------------------ A reaching B, on a fresh client
    stage = "negatives-A";
    const contextA2 = await browser.newContext({ locale: "en-US" });
    const apiA2 = apiFor(contextA2);
    await signOut(contextA);
    const a2 = await signIn(contextA2, userA);
    scenario("A signs in again on a fresh client", { workspaceId: a2.workspaceId });
    if (a2.workspaceId !== a.workspaceId) throw Error("A re-sign-in lost its workspace");

    const negA = {};
    for (const [key, method, path, data] of [
      ["botRead", "GET", `/api/agents/${botBId}`, undefined],
      ["botEdit", "PATCH", `/api/agents/${botBId}`, { name: mk("B-bot"), title: "Taken by A", roleDescription: "A's now", visibility: "private" }],
      ["botDelete", "DELETE", `/api/agents/${botBId}`, undefined],
      ["conversationRead", "GET", `/api/channels/${channelBId}`, undefined],
      ["conversationDelete", "DELETE", `/api/channels/${channelBId}`, undefined],
      ["attachmentRead", "GET", `/api/attachments/${attachmentBId}`, undefined],
      ["attachmentHead", "HEAD", `/api/attachments/${attachmentBId}`, undefined],
      ["attachmentDelete", "DELETE", `/api/attachments/${attachmentBId}`, undefined],
    ]) {
      const r = await contextA2.request.fetch(base + path, {
        method,
        headers: {
          Origin: base,
          ...(data ? { "content-type": "application/json" } : {}),
        },
        ...(data ? { data } : {}),
      });
      negA[key] = r.status();
      await r.body().catch(() => {});
    }
    const rosterA2 = expect(await apiA2("GET", "/api/agents"), "GET", "/api/agents", 200);
    const channelsA2 = expect(
      await apiA2("GET", "/api/channels?limit=50"),
      "GET",
      "/api/channels",
      200,
    );
    scenario("A reaching B by id", {
      statuses: negA,
      rosterContainsB: rosterA2.agents.some((row) => row.id === botBId),
      conversationsContainB: channelsA2.channels.some((row) => row.id === channelBId),
    });
    const refusedA = Object.entries(negA).filter(([, s]) => s === 404 || s === 403);
    if (refusedA.length !== Object.keys(negA).length)
      throw Error(`A obtained a non-refusal: ${JSON.stringify(negA)}`);
    if (rosterA2.agents.some((row) => row.id === botBId)) throw Error("A roster leaks B");

    // Owner positives, still true after every refusal above: A edits and reads its own; the
    // bytes B tried to delete or replay are byte-identical.
    const ownerAgain = await contextA2.request.fetch(
      `${base}/api/attachments/${attachmentAId}`,
      { headers: { Origin: base } },
    );
    const ownerAgainBytes = await ownerAgain.text();
    const ownerPatchAgain = await apiA2("PATCH", `/api/agents/${botAId}`, {
      name: mk("A-bot"),
      title: "A only, still mine",
      roleDescription: "A's own bot",
      visibility: "public",
    });
    const ownerReadAgain = await apiA2("GET", `/api/agents/${botAId}`);
    const ownerDelete = await apiA2("DELETE", `/api/channels/${channelAId}`);
    const ownerDeleteRead = await apiA2("GET", `/api/channels/${channelAId}`);
    const ownerUploadAgain = await uploadFor(
      contextA2,
      channelBId,
      "should-not-land",
      `${mk("nope")}.txt`,
    );
    scenario("A owner operations still succeed after all refusals", {
      attachmentUnchanged: ownerAgainBytes === markerA,
      botPatch: ownerPatchAgain.status,
      botTitle: ownerReadAgain.body?.agent?.title,
      ownConversationDelete: ownerDelete.status,
      ownConversationReadAfterDelete: ownerDeleteRead.status,
      uploadToBConversation: ownerUploadAgain.status(),
    });
    if (ownerAgainBytes !== markerA) throw Error("A's bytes changed");
    if (ownerPatchAgain.status !== 200) throw Error("A lost the ability to edit its own bot");
    if (ownerUploadAgain.status() < 400)
      throw Error("A could bind an attachment to B's conversation");

    // B's own still work after A's refusals (B edits its own bot, reads its own bytes).
    const bPatch = await apiB("PATCH", `/api/agents/${botBId}`, {
      name: mk("B-bot"),
      title: "B only, still mine",
      roleDescription: "B's own bot",
      visibility: "public",
    });
    const bGet = await contextB.request.fetch(`${base}/api/attachments/${attachmentBId}`, {
      headers: { Origin: base },
    });
    const bBytes = await bGet.text();
    scenario("B owner operations still succeed after A's refusals", {
      botPatch: bPatch.status,
      attachmentUnchanged: bBytes === markerB,
    });
    if (bPatch.status !== 200) throw Error("B lost the ability to edit its own bot");
    if (bBytes !== markerB) throw Error("B's bytes changed");

    // ------------------------------------------------ management, invitation, member entries
    stage = "management-B";
    const mgmtB = {};
    for (const [key, method, path, data] of [
      ["inviteAccept", "POST", "/api/auth/invite/accept", {}],
      ["orgAddMember", "POST", "/api/auth/organization/add-member", { userId: b.userId, organizationId: a.workspaceId }],
      ["orgCreate", "POST", "/api/auth/organization/create", { name: mk("sneaky") }],
      ["authAdminCreateUser", "POST", "/api/auth/admin/create-user", { email: mk("x") + "@t04.example.test" }],
      ["authAdminListUsers", "GET", "/api/auth/admin/list-users", undefined],
      ["adminStatus", "GET", "/api/admin/status", undefined],
      ["adminAudit", "GET", "/api/admin/audit-events", undefined],
      ["adminRevokeASessions", "POST", `/api/admin/people/${a.userId}/revoke-sessions`, {}],
      ["adminTerminateAComputers", "POST", `/api/admin/people/${a.userId}/terminate-computers`, {}],
      ["adminNetwork", "GET", "/api/admin/enterprise/network", undefined],
      ["adminCapabilities", "GET", "/api/admin/enterprise/capabilities", undefined],
    ]) {
      const r = await contextB.request.fetch(base + path, {
        method,
        headers: {
          Origin: base,
          ...(data ? { "content-type": "application/json" } : {}),
        },
        ...(data ? { data } : {}),
      });
      mgmtB[key] = r.status();
      await r.body().catch(() => {});
    }
    // The privileged escalation attempt: B claims a platform role and A's workspace in its own
    // session update, if any such write exists at all.
    const escalate = await contextB.request.fetch(`${base}/api/auth/change-session`, {
      method: "POST",
      headers: { Origin: base, "content-type": "application/json" },
      data: { activeOrganizationId: a.workspaceId, role: "admin" },
    });
    mgmtB.sessionEscalation = escalate.status();
    await escalate.body().catch(() => {});
    const bSession = await contextB.request
      .fetch(`${base}/api/auth/get-session`)
      .then((r) => r.json())
      .catch(() => null);
    scenario("B against management, invitation and member entries", {
      statuses: mgmtB,
      workspaceStillB: bSession?.session?.activeOrganizationId === b.workspaceId,
      platformRole: bSession?.user?.role ?? "none",
    });
    const refusedMgmt = Object.entries(mgmtB).filter(
      ([k, s]) => s === 403 || s === 404 || s === 401 || s === 400 || s === 405,
    );
    if (refusedMgmt.length !== Object.keys(mgmtB).length)
      throw Error(`a management entry answered success: ${JSON.stringify(mgmtB)}`);
    if (bSession?.session?.activeOrganizationId !== b.workspaceId)
      throw Error("B escaped its workspace");
    if (bSession?.user?.role === "admin") throw Error("B escalated to admin");

    // The member state of A's space is unchanged: A signs in, sees only its own roster, and the
    // platform-level attempts above never added B to A's workspace.
    const rosterA3 = await apiA2("GET", "/api/agents");
    const peopleStill = await contextA2.request.fetch(`${base}/api/auth/get-session`);
    const aSession = await peopleStill.json().catch(() => null);
    scenario("A's space still single-owner after B's attempts", {
      workspaceStillA: aSession?.session?.activeOrganizationId === a.workspaceId,
      rosterCount: (rosterA3.body?.agents ?? []).length,
      rosterOnlyA: (rosterA3.body?.agents ?? []).every((row) => row.id !== botBId),
    });

    // ------------------------------------------------ anonymous and cross-cache attempts
    stage = "anonymous";
    const anon = await browser.newContext({ locale: "en-US" });
    const anonStatuses = {};
    for (const [key, method, path, headers] of [
      ["attachment", "GET", `/api/attachments/${attachmentAId}`, {}],
      ["attachmentEtag", "GET", `/api/attachments/${attachmentAId}`, etag ? { "if-none-match": etag } : {}],
      ["attachmentHead", "HEAD", `/api/attachments/${attachmentAId}`, {}],
      ["bot", "GET", `/api/agents/${botAId}`, {}],
      ["connections", "GET", "/api/plugins/connections", {}],
    ]) {
      const r = await anon.request.fetch(base + path, {
        method,
        headers: { Origin: base, ...(headers ?? {}) },
      });
      anonStatuses[key] = r.status();
      await r.body().catch(() => {});
    }
    scenario("anonymous requests (including an etag replay)", { statuses: anonStatuses });
    await anon.close();
    await contextA2.close();
    await contextB.close();

    return evidence;
  } catch (error) {
    evidence.failedAt = { stage, error: String(error), at: now() };
    return evidence;
  }
})
