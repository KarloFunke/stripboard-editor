import { PRIVACY_MD, markdownResponse } from "@/data/agentDocs";

export function GET() {
  return markdownResponse(PRIVACY_MD);
}
