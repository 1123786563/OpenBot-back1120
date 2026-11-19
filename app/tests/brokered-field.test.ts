import { expect, test } from "bun:test";
import type { BrokerField } from "@/lib/plugins/mutations";
import { BROKER_FIELD_KEYS } from "../../server/src/plugins/broker";
import { requiredKey } from "../../tests/e2e/fixtures/brokered-field";

test("the browser's full connection field fixture covers the vendor schema", () => {
  const field: Required<BrokerField> = requiredKey;
  expect(Object.keys(field).sort()).toEqual([...BROKER_FIELD_KEYS].sort());
});
