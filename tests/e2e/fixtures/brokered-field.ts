import type { BrokerField } from "../../../server/src/plugins/broker";

export const requiredKey = {
  name: "firecrawl_api_key",
  label: "Firecrawl API key",
  help: "Your Firecrawl API key, a token starting with fc-",
  required: true,
  secret: true,
  default: "fixture-supplied-default",
} satisfies Required<BrokerField>;

export const optionalUrl = {
  name: "base_url",
  label: "Base URL",
  help: "",
  required: false,
  secret: false,
} satisfies BrokerField;
