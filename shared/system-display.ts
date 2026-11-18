export type SystemDisplay =
  | {
      key:
        | "Routine"
        | "Delegated task"
        | "A question"
        | "Follow-up"
        | "Runs when asked";
    }
  | {
      key: "Run of {{name}}" | "Delegated to {{name}}" | "Asked by {{name}}";
      name: string;
    };

export type ActivityStarts = {
  schedules: { schedule: string; scheduleZhCN: string; timezone: string }[];
  events: string[];
};
