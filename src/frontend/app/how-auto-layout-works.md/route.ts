import { AUTO_LAYOUT_MD, markdownResponse } from "@/data/agentDocs";

export function GET() {
  return markdownResponse(AUTO_LAYOUT_MD);
}
