import { UPDATES_MD, markdownResponse } from "@/data/agentDocs";

export function GET() {
  return markdownResponse(UPDATES_MD);
}
