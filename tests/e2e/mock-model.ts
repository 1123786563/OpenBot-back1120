import { LLMock } from "@copilotkit/aimock";
import { fixedReply } from "./model-reply";

const model = new LLMock({
  port: Number(process.env.OPENBOT_E2E_MODEL_PORT ?? 3901),
});
model.onMessage(/.*/, { content: fixedReply });
await model.start();
