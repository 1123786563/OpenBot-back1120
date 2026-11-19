type Component = Record<string, unknown> & { id: string; component: string };

export function generatedSurface(
  surfaceId: string,
  components: readonly Component[],
  dataModel?: Record<string, unknown>,
) {
  const catalogId = "openbot/ui@1";
  return {
    id: `activity-${surfaceId}`,
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId,
      target: "chat",
      catalogId,
      status: "ready",
      rejected: [],
      operations: [
        { version: "1.0", createSurface: { surfaceId, catalogId, dataModel } },
        { version: "1.0", updateComponents: { surfaceId, components } },
      ],
    },
  };
}
