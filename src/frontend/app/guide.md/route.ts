import { GUIDE_MD, markdownResponse } from "@/data/agentDocs";

export function GET() {
  return markdownResponse(GUIDE_MD);
}
